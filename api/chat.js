// ============================================================
//  AI Pipeline — api/chat.js (최종 안정화 & 타임아웃 방지 버전)
// ============================================================

export const config = { runtime: 'edge' };

// Qwen의 사고 과정을 제한하여 타임아웃을 방지합니다.
const QWEN_SYSTEM = `당신은 시니어 개발자입니다. 
사용자 요청에 대해 '핵심 코드 초안'과 간단한 설계 포인트만 간결하게 작성하세요. 
불필요한 서론이나 긴 사고 과정은 생략하세요.`;

const GEMINI_SYSTEM = `당신은 시니어 소프트웨어 엔지니어입니다.
전달받은 초안을 바탕으로 실무 수준의 완성된 최종 답변을 작성하세요.

[출력 규칙]
- 최종 답변만 출력 (검토 과정이나 수정 내역 언급 금지)
- 구성: 완성된 코드 + 핵심 설명 + 테스트 코드 (정상/엣지케이스)
- 초안이 부실하거나 없더라도, 사용자 요청을 분석하여 직접 코드를 완성할 것`;

// 사고 과정 태그를 제거하고 본문만 추출하는 함수
function stripThinking(text) {
  if (!text) return "";
  return text.replace(/\[사고 과정\][\s\S]*?\[\/사고 과정\]/g, '').replace(/\[답변\]/g, '').trim();
}

// 토큰 수 추정 함수
function estimateTokens(text) {
  const koreanCharCount = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  const otherCharCount = text.length - koreanCharCount;
  return Math.ceil(koreanCharCount * 1.5 + otherCharCount * 0.25);
}

// Qwen 호출 함수 (속도가 빠른 모델 위주로 배치)
async function callQwen(messages, apiKey, referer) {
  const model = 'qwen/qwen-2.5-72b-instruct:free'; // 응답 속도가 빠른 모델 사용
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
        max_tokens: 1500, // 타임아웃 방지를 위해 출력 길이 제한
        temperature: 0.4,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content;
    }
  } catch (err) {
    console.error("Qwen 호출 실패:", err.message);
  }
  return null;
}

// Gemini 호출 함수 (출력 토큰을 넉넉히 확보)
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
          maxOutputTokens: 8000, // 긴 코드도 잘리지 않게 설정
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
      const send = (data) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

      try {
        // 1. Qwen 단계: 빠른 초안 생성 (사고 과정 최소화)
        send({ stage: 'qwen_start', message: '🧠 아키텍처 설계 및 초안 작성 중...' });
        const qwenRaw = await callQwen([
          { role: 'system', content: QWEN_SYSTEM },
          { role: 'user', content: userMessage }
        ], OPENROUTER_API_KEY, referer);
        
        const qwenDraft = stripThinking(qwenRaw);

        // 2. Gemini 단계: 최종 완성 (초안이 없어도 직접 수행)
        send({ stage: 'gemini_start', message: '🔍 코드 최적화 및 최종 답변 생성 중...' });

        const geminiInput = `
[사용자 요청]
${userMessage}

[참고용 초안]
${qwenDraft || "초안 생성 실패. 사용자 요청을 분석하여 직접 답변을 작성할 것."}

위 내용을 바탕으로 시니어급 최종 답변을 완성해줘.`;

        const final = await callGemini(GEMINI_SYSTEM, geminiInput, GEMINI_API_KEY);

        // 최종 결과 전송
        send({ 
          stage: 'done', 
          final, 
          tokens: { input: estimateTokens(userMessage) } 
        });

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
