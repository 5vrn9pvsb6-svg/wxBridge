import os from 'node:os';
import path from 'node:path';

export function defaultServiceEnvFile(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'codexbridge', 'weixin.service.env');
}

export function configureServiceHome() {}
