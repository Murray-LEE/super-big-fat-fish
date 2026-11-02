/**
 * tools/lib/theme.mjs —— 一点小彩蛋：大肥鱼 / 鲸鱼娘 的术语表
 *
 * 原则：**只改"给人看的措辞"，不改任何机器读的字段** ✓
 *   · `--json` 输出、票面 Markdown 关键字、文件路径、退出码：一律不动 ✗
 *   · 终端上多一句好玩的叫法，坏不了事 ✓
 *
 * 想换主题词，只改这个文件；工具里都从 `W`/`t()` 取。
 */

export const W = {
  agent: '超级大肥鱼',        // 调度者
  pond: '鱼塘',               // 票板
  chum: '投喂',               // 派活（把活喂给某人）
  bubble: '冒个泡',           // 回票（回一声）
  nibble: '尝过了',           // 验收通过
  stranded: '搁浅',           // 阻塞
  migrate: '洄游',            // 归档
  swim: '还在游',             // 已派未回
  spawn: '添饭',              // 开新票（鲸鱼娘：白米饭是算力硬通货）
  closed: '收碗',             // 结票（饭吃完，碗收走）
};

/** 给人看的组合词：正式名（彩蛋名） */
export const t = (key, plain) => {
  const w = W[key] || '';
  return w ? `${plain}（${w}）` : plain;
};

/** 术语表：`--glossary` 打印 */
export const GLOSSARY = [
  ['调度者', W.agent, '负责算账和投喂的那一位'],
  ['票板', W.pond, '所有票待着的地方；鱼塘里鱼多不多看这个'],
  ['开票', W.spawn, '新票进碗（鲸鱼娘的白米饭）'],
  ['派活', W.chum, '把票喂给负责的那条线'],
  ['回票', W.bubble, '负责人冒个泡说做完了'],
  ['验收', t('nibble', '验收'), '尝一口，看熟没熟'],
  ['阻塞', W.stranded, '卡住了，等人拉一把'],
  ['归档', W.migrate, '旧票游去归档池'],
  ['结票', W.closed, '饭吃完，碗收走'],
];

export const glossaryText = () =>
  GLOSSARY.map(([plain, themed, why]) => `  ${plain.padEnd(6)} → ${String(themed).padEnd(12)} ${why}`).join('\n');
