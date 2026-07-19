import DiagnosisClient from "./DiagnosisClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default function DiagnosisPage() {
  return <DiagnosisClient />;
}
