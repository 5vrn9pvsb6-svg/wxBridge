import os from 'node:os';
import path from 'node:path';

export function defaultServiceEnvFile(env = process.env, home = os.homedir()) {
  return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'codexbridge', 'weixin.service.env');
}

export function configureServiceHome(home, env = process.env) {
  env.APPDATA ||= path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA ||= path.join(home, 'AppData', 'Local');
}
