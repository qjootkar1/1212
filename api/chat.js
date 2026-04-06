// ============================================================
//  AI Pipeline — api/chat.js (즉시 응답 & 타임아웃 방어 전체 코드)
// ============================================================

export const config = { runtime: 'edge' };

const QWEN_SYSTEM = `시니어 개발자입니다. 초안 코드만 아주 간결하게 작성하세요.`;
const GEMINI_SYSTEM = `당신은 시니어 소프트웨어 엔지니어입니다. 
초안이 없더라도 사용자 요청을 분석하여 직접 완성된 코드를 출력하세요. 
최종 답변만 작성하며, 테스트 코드를 포함하세요.`;

function stripThinking(text) {
  if (!text) return "";
  return text.replace(/\[사고 과정\][\s\S]*?\[\/사고 과정\]/g, '').replace(/\[답변\]/g, '').trim();
}

// ✅ Qwen 호출 함수: 타임아웃 15초 적용 (무료 모델 대기열 방어)
async function callQwen(messages, apiKey, referer) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15초 지나면 포기

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
      },
      body: JSON.stringify({
        model: 'qwen/qwen-2.5-72b-instruct:free',
        messages,
        max_tokens: 1000,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content;
    }
  } catch (err) {
    console.error("Qwen Skip (Timeout or Error)");
  }
  return null;
}

async function callGemini(systemPrompt, userMessage, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 6000, temperature: 0.2 },
      }),
    }
  );
  if (!res.ok) throw new Error("Gemini API Error");
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });

  const { messages } = await req.json();
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const referer = req.headers.get('origin') || 'http://localhost:3000';
  const userMessage = messages[messages.length - 1].content;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

      try {
        // 1. Qwen 시도 (15초 안에 안 나오면 바로 넘김)
        send({ stage: 'qwen_start', message: '🧠 전략 구상 중 (빠른 모드)...' });
        const qwenRaw = await callQwen([{ role: 'system', content: QWEN_SYSTEM }, { role: 'user', content: userMessage }], OPENROUTER_API_KEY, referer);
        const qwenDraft = stripThinking(qwenRaw);

        // 2. Gemini 즉시 개입
        send({ stage: 'gemini_start', message: '🔍 코드 완성 및 검증 중...' });
        const geminiInput = `요청: ${userMessage}\n\n초안: ${qwenDraft || "없음(직접 작성 요망)"}`;
        const final = await callGemini(GEMINI_SYSTEM, geminiInput, GEMINI_API_KEY);

        send({ stage: 'done', final });
      } catch (err) {
        send({ stage: 'error', error: err.message });
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
