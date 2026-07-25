import { callDiagnosisStream, isTongueVisionConfigured } from "@/lib/diagnosis-api";
import { buildTongueVisionPrompt } from "@/lib/diagnosis-prompts";
import { readJsonRequest } from "@/lib/diagnosis-request";
import { markdownNdjsonResponse } from "@/lib/diagnosis-safety";
import { validateCollectRequiredFields } from "@/lib/clinical-required-fields";

const MAX_IMAGE_SIZE = 5_600_000; // ~4MB binary as base64
const MAX_USER_INPUT_CHARS = 12000;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/i;

function isValidTongueImageDataUrl(value: string): boolean {
  const match = value.match(IMAGE_DATA_URL_PATTERN);
  if (!match) return false;
  const mime = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  if (base64.length < 64) return false;
  if (base64.length % 4 !== 0) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return false;
  }
  if (bytes.length === 0 || bytes.length > 4_200_000) return false;
  if (mime === "png") return bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (mime === "jpg" || mime === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return true;
}

export async function POST(req: Request) {
  const parsed = await readJsonRequest(req, { maxBytes: MAX_IMAGE_SIZE + MAX_USER_INPUT_CHARS + 2048 });
  if (!parsed.ok) return parsed.response;
  const body = parsed.body && typeof parsed.body === "object" ? parsed.body as { userInput?: unknown; patientSex?: unknown; tongueImage?: unknown; tongueImageConsent?: unknown } : {};
  const userInput = typeof body.userInput === "string" ? body.userInput : "";
  const tongueImage = typeof body.tongueImage === "string" ? body.tongueImage : "";
  const tongueImageConsent = body.tongueImageConsent === true;
  if (!userInput.trim()) {
    return new Response(JSON.stringify({ error: "userInput required" }), { status: 400 });
  }
  if (userInput.length > MAX_USER_INPUT_CHARS) {
    return Response.json({ error: "病历文本过长，请压缩至12000字以内后再提交" }, { status: 413 });
  }

  if (tongueImage && tongueImage.length > MAX_IMAGE_SIZE) {
    return new Response(JSON.stringify({ error: "舌象图片过大，请压缩至4MB以内" }), { status: 400 });
  }
  if (tongueImage && !tongueImageConsent) {
    return Response.json({ error: "舌照外发分析前需确认已取得患者授权。" }, { status: 400 });
  }
  const requiredFields = validateCollectRequiredFields(body.patientSex);
  if (!requiredFields.ok) {
    return Response.json({ error: requiredFields.error, code: "required_field_missing", field: "sex" }, { status: 400 });
  }
  if (tongueImage && !isValidTongueImageDataUrl(tongueImage)) {
    return Response.json({ error: "舌象图片格式不支持，请上传PNG/JPEG/WebP位图" }, { status: 400 });
  }
  if (tongueImage && !isTongueVisionConfigured()) {
    return Response.json(
      { error: "舌照识别服务未配置，请先手动录入舌象后再提交。" },
      { status: 503 },
    );
  }

  const hasImages = { tongue: !!tongueImage };
  if (!hasImages.tongue) {
    // The browser has already normalized the structured HIS draft before M01. Calling a language
    // model again for text-only collection adds latency and can invent facts; keep M01 deterministic
    // and reserve model work for information-gain questioning and clinical reasoning.
    return markdownNdjsonResponse([
      "病历信息已采集，正在评估是否需要补充关键问诊。",
      "",
      "<!-- DIAGNOSIS_JSON_START -->",
      "{}",
      "<!-- DIAGNOSIS_JSON_END -->",
    ].join("\n"));
  }
  const prompt = buildTongueVisionPrompt();

  const images = tongueImage ? { tongue: tongueImage as string } : undefined;

  return callDiagnosisStream(prompt, images ? "glm" : "deepseek", images, "collect", { requestSignal: req.signal });
}
