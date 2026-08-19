export const CUSTOMER_ID_HEADER = "x-cdss-customer-id";

export function parseCustomerId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{6,64}$/.test(text) ? text : undefined;
}
