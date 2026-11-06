export type InstallPlatform = "ios" | "android" | "mac" | "desktop";
export function installPlatform(
  agent: string,
  platform: string,
  touchPoints: number,
): InstallPlatform {
  if (/iphone|ipad|ipod/i.test(agent) || (platform === "MacIntel" && touchPoints > 1)) return "ios";
  if (/android/i.test(agent)) return "android";
  return /mac/i.test(platform) ? "mac" : "desktop";
}
export function installInstructions(platform: InstallPlatform): string[] {
  switch (platform) {
    case "ios":
      return [
        "Open this website in Safari.",
        "Tap Share, then Add to Home Screen.",
        "Enable Open as Web App if offered, then tap Add.",
      ];
    case "android":
      return [
        "Open this website in Chrome or another browser that supports web-app installation.",
        "Open the browser menu, then choose Install app or Add to Home screen.",
        "Confirm the installation in the browser.",
      ];
    case "mac":
      return [
        "In Safari, choose File → Add to Dock. In Chrome or Edge, use the browser’s Install app command.",
        "Confirm the installation. The app continues to use this website’s deployed version.",
      ];
    default:
      return [
        "Open this website in Chrome or Edge.",
        "Use the Install app icon in the address bar, or the browser menu’s Apps / Install command.",
        "Confirm the installation in the browser.",
      ];
  }
}

/** Only entrances may offer installation automatically; transaction screens stay undisturbed. */
export function isInstallEntrance(pathname:string):boolean{
 return ['/', '/auth','/workspace','/rider','/rider/'].includes(pathname)||/^\/(?:guest|delivery)\/[^/]+\/?$/.test(pathname);
}