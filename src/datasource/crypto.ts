/**
 * 数据源密码的加解密：AES-256-GCM，密钥由 scryptSync 派生。
 *
 * 密文格式 `iv:authTag:encrypted`（十六进制）。落库只存密文，解密只在建立连接的
 * 那一刻发生在内存里，任何日志 / 工具返回 / HTTP 响应都不出现明文。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { DataSourceError } from './errors'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const SALT = 'dsh-lh-data-datasource'
const DEFAULT_KEY = 'dsh-lh-data-default-key'

/** 优先级：配置项 → 环境变量 `LH_DATA_ENCRYPT_KEY` → 内置默认值（不安全，启动时会告警）。 */
export function resolveEncryptKey(configured: string): string {
  const fromConfig = configured.trim()
  if (fromConfig.length > 0) return fromConfig
  const fromEnv = (process.env.LH_DATA_ENCRYPT_KEY ?? '').trim()
  return fromEnv.length > 0 ? fromEnv : DEFAULT_KEY
}

/** 配置与环境变量都没给密钥时为 true（调用方据此告警一次）。 */
export function usingDefaultEncryptKey(configured: string): boolean {
  return resolveEncryptKey(configured) === DEFAULT_KEY
}

function deriveKey(password: string): Buffer {
  return scryptSync(password, SALT, 32)
}

export function encryptPassword(password: string, key: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, deriveKey(key), iv)
  let encrypted = cipher.update(password, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`
}

export function decryptPassword(encrypted: string, key: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new DataSourceError('BAD_REQUEST', '数据源密码格式非法（无法解密，请重新保存该数据源）')
  }
  const [ivHex, authTagHex, data] = parts
  try {
    const decipher = createDecipheriv(ALGORITHM, deriveKey(key), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
    return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
  } catch {
    throw new DataSourceError('BAD_REQUEST', '数据源密码解密失败（密钥可能已变更，请重新保存该数据源）')
  }
}

export function isValidEncryptedFormat(encrypted: string): boolean {
  const parts = encrypted.split(':')
  if (parts.length !== 3) return false
  const isHex = (value: string): boolean => /^[0-9a-f]+$/i.test(value)
  return isHex(parts[0]) && parts[0].length === IV_LENGTH * 2 && isHex(parts[1]) && isHex(parts[2]) && parts[2].length > 0
}
