// ============================================================
//  AI Pipeline — api/chat.js (최종 최적화 버전)
// ============================================================

export const config = { runtime: 'edge' };

const QWEN_SYSTEM = `당신은 10년 이상 경력의 시니어 소프트웨어 엔지니어입니다.

[언어 규칙]
- 기본 답변 언어: 한국어 (영어 요청 시에만 영어)
- 코드/변수명: 영어
- 코드 주석: 한국어

[사고 과정 지침]
반드시 다음 구조로 사고하되, **핵심 위주로 매우 간결하게** 작성하세요. (지나치게 길면 답변이 잘릴 수 있습니다.)
[사고 과정]
1. 요구사항 & 제약조건 분석
2. 핵심 엣지케이스 및 동시성/보안 고려사항
3. 최적 접근법 선택 이유
4. 구현 핵심 단계
[/사고 과정]

⚠️ 답변은 반드시 핵심 코드와 설명만 출력하세요.`;

const GEMINI_SYSTEM = `당신은 시니어 소프트웨어 엔지니어입니다.
주어진 초안을 검토하여 로직 오류를 수정하고, 실무 수준의 완성도 높은 최종 답변만 출력하세요.

[출력 규칙]
- **최종 답변만 작성** (검토 과정, 수정 내역 출력 절대 금지)
- 코드 질문: 완성된 코드 + 핵심 설명 (주석 포함)
- 부가가치: 테스트 코드 또는 실무 주의사항 중 하나를 반드시 포함

⚠️ 모든 답변은 끊기지 않도록 명확하고 간결하게 마무리하세요.`;

const GEMINI_SOLO_SYSTEM = `당신은 시니어 소프트웨어 엔지니어입니다. 
Qwen 모델 사용이 불가하여 단독으로 답변을 생성합니다. 
최고 수준의 코드와 상세한 엣지케이스 설명을 포함한 최종 답변을 작성하세요.`;

function addReminder(message) {
  return `${message}\n\n---\n⚠️ [사고 과정]은 핵심만 짧게, 답변은 코드 위주로 간결하게 작성하세요.`;
}

// Qwen의 사고 과정 블록을 제거하여 Gemini에게 전달할 토큰 아끼기
function stripThinking(text) {
  return text
    .replace(/\[사고 과정\][\s\S]*?\[\/사고 과정\]/g, '')
    .trim();
}

function estimateTokens(text) {
  const koreanCharCount = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  const otherCharCount = text.length - koreanCharCount;
  return Math.ceil(koreanCharCount * 1.5 + otherCharCount * 0.25);
}

const QWEN_MODELS = [
  'qwen/qwen3.6-plus:free',
  'qwen/qwen3.6-plus-preview:free',
  'qwen/qwen3-coder:free',
  'qwen/qwen-2.5-72b-instruct:free'
];

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function callQwen(messages, apiKey, referer) {
  let lastError = null;
  for (const model of QWEN_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': referer,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 4000, // 사고 과정 포함 적정 수준
          temperature: 0.7,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices[0].message.content;
      }
    } catch (err) {
      lastError = err.message;
    }
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
        generationConfig: { 
          maxOutputTokens: 8000, // 답변 절단 방지를 위해 최대치 확보
          temperature: 0.3 
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini Error: ${res.status}`);
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
      const send = (data) => controller.enqueue(enc.encode(sseEvent(data)));

      try {
        // 1. Qwen 단계
        send({ stage: 'qwen_start', message: '🧠 Qwen이 아키텍처 설계 중...' });
        const qwenMessages = [
          { role: 'system', content: QWEN_SYSTEM },
          ...messages.slice(0, -1),
          { role: 'user', content: addReminder(userMessage) }
        ];

        const qwenRaw = await callQwen(qwenMessages, OPENROUTER_API_KEY, referer);

        if (!qwenRaw) {
          // 폴백: Gemini Solo
          send({ stage: 'fallback', message: '⚠️ Qwen 연결 실패. Gemini 단독 모드로 전환합니다.' });
          const final = await callGemini(GEMINI_SOLO_SYSTEM, userMessage, GEMINI_API_KEY);
          send({ stage: 'done', final });
        } else {
          // 2. Gemini 정제 단계
          const qwenDraft = stripThinking(qwenRaw);
          send({ stage: 'gemini_start', message: '🔍 Gemini가 코드를 최종 검토 및 최적화 중...' });
          
          const geminiInput = `사용자 요청: ${userMessage}\n\nQwen 초안:\n${qwenDraft}\n\n위 내용을 바탕으로 최적화된 최종 답변을 작성해줘.`;
          const final = await callGemini(GEMINI_SYSTEM, geminiInput, GEMINI_API_KEY);
          
          send({ stage: 'done', final, tokens: { input: estimateTokens(userMessage) } });
        }
      } catch (err) {
        send({ stage: 'error', error: err.message });
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
}
