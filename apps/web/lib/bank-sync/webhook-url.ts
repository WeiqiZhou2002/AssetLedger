export function plaidWebhookUrl(appUrl: string) {
  return `${appUrl.replace(/\/+$/, "")}/api/plaid/webhook`;
}
export function usesHttpsWebhook(appUrl: string) {
  return new URL(appUrl).protocol === "https:";
}
