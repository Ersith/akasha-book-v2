// 把真实 accepted assembly 的 akasha:self 段起点接到 gate contribution 上。
// 只读同一 token 的 assembly；逐段用官方 renderPrompt 求实际文本；不搜索正文。
let renderPrompt;
try { ({ renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')); }
catch { renderPrompt = (text, ctx) => typeof text === 'function' ? text(ctx) : text; }

export const SELF_SECTION_NAME = 'akasha:self';
export const SECTION_SEPARATOR = '\n\n';

export function createSelfContributionProvider({ systemPrompt, contributionFor, sectionName = SELF_SECTION_NAME, beforeAssemble, afterAssemble } = {}) {
  if (!systemPrompt || typeof systemPrompt.assemble !== 'function') throw new TypeError('systemPrompt.assemble 必须是函数');
  if (typeof contributionFor !== 'function') throw new TypeError('contributionFor 必须是函数');
  const byToken = new WeakMap();
  const originalDescriptor = Object.getOwnPropertyDescriptor(systemPrompt, 'assemble');
  const original = systemPrompt.assemble.bind(systemPrompt);
  let disposed = false;
  const assemble = async (context) => {
    if (disposed) return original(context);
    if (beforeAssemble) await beforeAssemble(context);
    const assembly = await original(context);
    // 卸载可能发生在异步组装期间；此时不得用旧模块重新绑定 machine。
    if (disposed) return assembly;
    const token = context && typeof context === 'object' ? context.selfStep : null;
    if (token) byToken.set(token, assembly);
    if (afterAssemble) await afterAssemble(context, assembly);
    return assembly;
  };
  systemPrompt.assemble = assemble;
  const provider = (token) => {
    const contribution = contributionFor(token);
    if (contribution === void 0) return void 0;
    const assembly = token && typeof token === 'object' ? byToken.get(token) : void 0;
    if (!assembly || !Array.isArray(assembly.sections)) throw new TypeError('缺少同 token 的 accepted assembly');
    let offset = 0;
    let systemStart;
    let selfText;
    for (const section of assembly.sections) {
      const rendered = renderPrompt({ sections: [section], variables: assembly.variables });
      if (rendered.length === 0) continue;
      if (section.name === sectionName) { systemStart = offset; selfText = rendered; break; }
      offset += rendered.length + SECTION_SEPARATOR.length;
    }
    if (systemStart === void 0) throw new TypeError('assembly 缺少 akasha:self');
    if (selfText !== contribution.sectionText) throw new TypeError('assembly self 文本与 contribution 不一致');
    return { ...contribution, systemStart };
  };
  provider.dispose = () => {
    if (disposed) return;
    disposed = true;
    // Cordis 读取方法会返回 shadow proxy；own descriptor 才能比较实际 wrapper。
    // 若上方已有新 wrapper，只停用本层，避免卸载旧插件时覆盖新插件。
    if (Object.getOwnPropertyDescriptor(systemPrompt, 'assemble')?.value === assemble) {
      if (originalDescriptor) Object.defineProperty(systemPrompt, 'assemble', originalDescriptor);
      else delete systemPrompt.assemble;
    }
    // 不清 byToken：已接受的旧步骤仍可通过其持有的旧 provider 完成读取。
  };
  return provider;
}
