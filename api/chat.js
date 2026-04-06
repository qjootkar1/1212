// ============================================================
//  AI Pipeline — api/chat.js (구조적 중단 방지 및 최종 완결 버전)
// ============================================================

export const config = { runtime: 'edge' };

const QWEN_SYSTEM = `당신은 10년 이상 경력의 시니어 소프트웨어 엔지니어입니다.
[지침]
1. [사고 과정]은 3문장 이내로 아주 간결하게 핵심만 요약하세요.
2. 사고 과정 직후 반드시 [답변] 태그를 붙이고 코드를 작성하세요.
3. 말이 길어지면 시스템 타임아웃으로 연결이 끊기니, 불필요한 서론 없이 바로 본론(코드)으로 들어가세요.`;

const GEMINI_SYSTEM = `당신은 시니어 소프트웨어 엔지니어입니다.
전달받은 'Qwen 초안'이 미완성이거나 비어 있더라도, '사용자 요청'을 분석하여 직접 최고의 완성된 답변을 작성하세요.

[출력 규칙]
- 오직 최종 답변만 출력 (검토 과정이나 수정 내역 언급 금지)
- 코드 질문: 실행 가능한 완성된 코드 + 핵심 설명 + 테스트 코드 포함
- 부가가치: 실무 사용 시 주의사항이나 확장성 제안 포함

⚠️ 답변이 중간에 잘리지 않도록 명확하고 간결하게 마무리하세요.`;

const GEMINI_SOLO_SYSTEM = `당신은 시니어 소프트웨어 엔지니어입니다. 
현재 메인 파이프라인(Qwen) 연결이 원활하지 않아 단독으로 답변을 생성합니다. 
사용자의 요청에 대해 최적화된 코드와 상세한 설명을 포함한 최종 답변을 작성하세요.`;

function addReminder(message) {
  return `${message}\n\n---\n⚠️ [사고 과정]은 3줄 이내로 짧게, [답변] 태그 뒤에 코드를 바로 작성하세요.`;
}

// 사고 과정이 잘리거나 태그가 닫히지 않아도 내용을 추출하는 강화된 함수
function stripThinking(text) {
  if (!text) return "";
  
  // 1. 정상적인 구조 제거 시도
  let cleanText = text.replace(/\[사고 과정\][\s\S]*?\[\/사고 과정\]/g, '').trim();
  
  // 2. 만약 사고 과정 태그가 닫히지 않고 끝났을 경우 (타임아웃 상황)
  if (!cleanText || cleanText.length < 10) {
    const splitPoint = text.includes('[/사고 과정]') ? '[/사고 과정]' : '[사고 과정]';
    cleanText = text.split(splitPoint).pop().trim();
  }
  
  return cleanText.replace(/\[답변\]/g, '').trim();
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
          max_tokens: 2500, // 사고 과정과 초안 코드를 담기에 충분한 제한
          temperature: 0.6,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices[0].message.content;
      }
    } catch (err) {
      console.error(`Qwen 모델(${model}) 호출 실패:`, err.message);
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
          maxOutputTokens: 8000, 
          temperature: 0.2 
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API 오류: ${res.status}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

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
        // 1단계: Qwen 초안 생성
        send({ stage: 'qwen_start', message: '🧠 Qwen이 아키텍처를 설계 중입니다...' });
        const qwenMessages = [
          { role: 'system', content: QWEN_SYSTEM },
          ...messages.slice(0, -1),
          { role: 'user', content: addReminder(userMessage) }
        ];

        const qwenRaw = await callQwen(qwenMessages, OPENROUTER_API_KEY, referer);

        if (!qwenRaw) {
          // Qwen 실패 시 폴백
          send({ stage: 'fallback', message: '⚠️ Qwen 응답 지연으로 Gemini 단독 모드로 전환합니다.' });
          const final = await callGemini(GEMINI_SOLO_SYSTEM, userMessage, GEMINI_API_KEY);
          send({ stage: 'done', final });
        } else {
          // 2단계: Gemini 최종 정제
          const qwenDraft = stripThinking(qwenRaw);
          send({ stage: 'gemini_start', message: '🔍 Gemini가 코드를 최종 검토 및 완성 중입니다...' });
          
          const geminiInput = `
[사용자 요청]
${userMessage}

[Qwen 초안 정보]
${qwenDraft || "초안이 생성되지 않았거나 타임아웃되었습니다. 직접 답변을 작성하세요."}

위 정보를 바탕으로 완성된 시니어급 코드를 출력해줘.`;

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

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
