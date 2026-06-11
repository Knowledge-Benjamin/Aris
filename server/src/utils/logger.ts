export function info(message: string) {
  console.log(`[aris] ${message}`);
}

export function error(message: string, data?: unknown) {
  console.error(`[aris] ${message}`, data || "");
}
