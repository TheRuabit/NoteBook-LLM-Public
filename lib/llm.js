export async function chat(config, messages, { temperature = 0.3, maxTokens = 4096 } = {}) {
  if (!config.apiKey) throw new Error('未配置 API Key：请在右上角设置或设置 OPENAI_API_KEY 环境变量');
  const url = config.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('模型返回了空内容（推理模型可能占满了输出上限，请稍后重试）');
  return content;
}

// 从任意文本中提取第一个平衡的 JSON 对象（容忍前后多余文字）
function extractBalancedJson(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

// 容错解析 LLM 输出：优先整体 JSON，其次 ```json 代码块，最后平衡花括号提取
export function parseReply(raw) {
  const trimmed = raw.trim();
  const candidates = [];
  candidates.push(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const balanced = extractBalancedJson(trimmed);
  if (balanced) candidates.push(balanced);
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object') {
        // 模型偶尔把整个 JSON 又包成字符串，递归解包一次
        if (typeof obj.summary === 'string' && obj.summary.trim().startsWith('{')) {
          return parseReply(obj.summary);
        }
        return obj;
      }
    } catch { /* try next */ }
  }
  return { summary: raw, takeaways: [], highlight_sentences: [], notes_relation: '' };
}
