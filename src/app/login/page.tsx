"use client";

import { FormEvent, useState } from "react";
import { LockKeyhole, Loader2, Stethoscope } from "lucide-react";

const APP_BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || "");
const MAX_TOKEN_CHARS = 512;
const LOGIN_REQUEST_TIMEOUT_MS = 15_000;

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  if (!trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.includes("\\")) return "";
  return trimmed;
}

function appUrl(path: string): string {
  return `${APP_BASE_PATH}${path}`;
}

function getSafeNextPath(): string {
  const fallback = appUrl("/diagnosis");
  if (typeof window === "undefined") return fallback;
  const next = new URLSearchParams(window.location.search).get("next") || fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;

  try {
    const targetUrl = new URL(next, window.location.origin);
    if (targetUrl.origin !== window.location.origin) return fallback;
    const targetPath = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
    if (APP_BASE_PATH && targetUrl.pathname !== APP_BASE_PATH && !targetUrl.pathname.startsWith(`${APP_BASE_PATH}/`)) {
      return appUrl(targetPath);
    }
    return targetPath;
  } catch {
    return fallback;
  }
}

function getInitialError(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("error") === "not_configured"
    ? "系统尚未配置访问口令，请先设置 CDSS_API_TOKEN。"
    : "";
}

export default function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState(getInitialError);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), LOGIN_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(appUrl("/api/auth/access"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: trimmed }),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error || "访问口令校验失败。");
        return;
      }
      window.location.assign(getSafeNextPath());
    } catch (error) {
      setError(error instanceof DOMException && error.name === "AbortError"
        ? "访问口令校验超时，请稍后重试。"
        : "网络连接失败，请稍后重试。");
    } finally {
      window.clearTimeout(timeout);
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F7F9FB] px-4 text-gray-900">
      <section className="w-full max-w-[380px] rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3 border-b border-gray-100 pb-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
            <Stethoscope className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-bold">中医 CDSS</h1>
            <p className="text-xs text-gray-500">请输入访问口令</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <input
            aria-hidden="true"
            autoComplete="username"
            className="sr-only"
            id="cdss-username"
            name="username"
            readOnly
            tabIndex={-1}
            type="text"
            value="cdss-access"
          />
          <label className="block text-[13px] font-semibold text-gray-700" htmlFor="cdss-token">
            访问口令
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 focus-within:border-teal-300 focus-within:bg-white">
            <LockKeyhole className="h-4 w-4 shrink-0 text-gray-400" />
            <input
              id="cdss-token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value.slice(0, MAX_TOKEN_CHARS))}
              maxLength={MAX_TOKEN_CHARS}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-gray-300"
              placeholder="CDSS_API_TOKEN"
            />
          </div>
          {error && (
            <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] font-medium leading-relaxed text-red-700">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!token.trim() || isSubmitting}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-4 text-[13px] font-bold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
            进入系统
          </button>
        </form>
      </section>
    </main>
  );
}
