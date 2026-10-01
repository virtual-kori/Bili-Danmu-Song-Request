/**
 * QQ 音乐 zzc 签名算法（纯 Node 实现，移植自官方客户端的签名逻辑）。
 *
 * 步骤：
 *  1. 对明文做 SHA1，取大写十六进制串；
 *  2. 按固定索引表从哈希串中抽取 part1 / part2；
 *  3. 用固定混淆字节与哈希字节异或得到 20 字节 part3，Base64 后去掉 \ / + = 四种字符；
 *  4. 拼接 zzc + part1 + part3 + part2 并转小写。
 */
const crypto = require('crypto');

const PART_1_INDEXES = [23, 14, 6, 36, 16, 7, 19];
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
const SCRAMBLE_VALUES = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
];

/**
 * 计算 zzc 签名。
 *
 * @param {string|Buffer} payload 待签名明文
 * @returns {string} 形如 zzcXXXXXXXX... 的签名串（小写）
 */
function zzcSign(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const hex = crypto.createHash('sha1').update(buf).digest('hex').toUpperCase();

  const part1 = PART_1_INDEXES.map((i) => hex[i]).join('');
  const part2 = PART_2_INDEXES.map((i) => hex[i]).join('');

  const part3 = Buffer.alloc(20);
  for (let i = 0; i < SCRAMBLE_VALUES.length; i++) {
    part3[i] = SCRAMBLE_VALUES[i] ^ parseInt(hex.substr(i * 2, 2), 16);
  }

  const b64 = part3.toString('base64').replace(/[\\/+=]/g, '');
  return ('zzc' + part1 + b64 + part2).toLowerCase();
}

module.exports = { zzcSign };
