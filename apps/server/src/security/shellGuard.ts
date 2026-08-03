export function isShellAllowed(config: { allowShell: boolean }): boolean {
  return config.allowShell === true;
}
