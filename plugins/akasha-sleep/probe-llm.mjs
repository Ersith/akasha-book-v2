// 探针：能否从应用树直接动态导入官方 dsh-llm 并构造消息（v1.2.0 唤醒条的前提）。
const url = 'file:///<DSH_INSTALL>';
try {
  const mod = await import(url);
  console.log('import ok, createUserMessage =', typeof mod.createUserMessage);
  const msg = mod.createUserMessage({ content: [{ type: 'text', text: 'probe' }], source: { kind: 'user' } });
  console.log('message keys:', Object.keys(msg).join(','));
  console.log('message:', JSON.stringify(msg));
} catch (error) {
  console.log('IMPORT FAILED:', error.code, String(error.message).slice(0, 200));
}
