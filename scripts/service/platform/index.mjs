import * as macos from './macos.mjs';
import * as linux from './linux.mjs';
import * as windows from './windows.mjs';

export function getServicePlatform(platform = process.platform) {
  switch (platform) {
    case 'win32': return windows;
    case 'darwin': return macos;
    case 'linux': return linux;
    default: return linux;
  }
}
