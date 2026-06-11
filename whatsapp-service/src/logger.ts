export function info(message: string, ...args: unknown[]) {
  console.log(`[whatsapp-service] ${message}`, ...args);
}

export function error(message: string, ...args: unknown[]) {
  console.error(`[whatsapp-service] ${message}`, ...args);
}
