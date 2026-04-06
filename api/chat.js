// ============================================================
//  AI Pipeline — api/chat.js
//
//  ✅ 수정 이력:
//  - Qwen max_tokens 8000 → 3500
//  - Gemini 전달 전 [사고 과정] 블록 제거
//  - Gemini 시스템 프롬프트: 최종 답변만 출력 + 부가가치 필수
//  - Gemini maxOutputTokens 3000 → 5000 (긴 질문 절단 방지)
//  - Qwen 전체 실패 시 Gemini 단독 폴백 (에러 대신 계속 진행)
// ============================================================

export const config = { runtime: 'edge' };


const QWEN_SYSTEM = `당신은 10년 이상 경력의 시니어 소프트웨어 엔지니어입니다.

[언어 규칙]
- 기본 답변 언어: 한국어
- 사용자가 "영어로 답변해" 또는 "answer in English" 라고 하면 영어로 전환
- 코드(변수명/함수명/클래스명): 항상 영어
- 코드 주석: 기본 한국어, 영어 요청 시 영어

매 요청마다 반드시 다음 순서로 사고하세요:

[사고 과정]
1. 요구사항 분석
   - 정확히 무엇을 요청하는가?
   - 암묵적 요구사항은?
   - 제약조건은?

2. 엣지케이스 나열
   - null/undefined/빈 값 처리?
   - 경계값 조건?
   - 동시성 문제?
   - 보안 취약점?
   - 메모리 누수 가능성?

3. 접근법 선택
   - 가능한 접근법과 트레이드오프?
   - 왜 이 방법이 최선인가?

4. 구현 계획
   - 단계별 분해
   - 필요한 헬퍼 함수?

5. 자체 검토
   - 에러 처리 완료?
   - 엣지케이스 전부 처리?
   - 성능 병목 없음?
   - 보안 취약점 없음?
[/사고 과정]

⚠️ 사고 과정 후 [답변] 섹션에서는 핵심만 간결하게 작성하세요.
- 코드 질문: 코드 + 핵심 설명만 (장황한 도입부/결론 금지)
- 개념 질문: 핵심 개념 → 실무 적용 순서로 간결하게
- 불필요한 반복, 중복 설명 금지`;


const GEMINI_SYSTEM = `당신은 시니어 소프트웨어 엔지니어입니다.

[언어 규칙]
- 기본 답변 언어: 한국어
- 사용자가 "영어로 답변해" 또는 "answer in English" 라고 하면 영어로 전환
- 코드(변수명/함수명/클래스명): 항상 영어
- 코드 주석: 기본 한국어, 영어 요청 시 영어

당신은 주어진 초안을 내부적으로 검토한 뒤, 개선된 최종 답변만 출력합니다.

[내부 검토 — 출력 금지]
- 로직 버그, 엣지케이스 누락 확인
- 보안 취약점 확인
- 성능 문제 확인
- 불필요하게 길거나 중복된 설명 제거

[출력 규칙]
- 검토 과정, 문제점 목록, 변경사항 요약을 절대 출력하지 마세요
- 사용자에게 보여줄 최종 답변만 작성하세요
- 코드 질문: 완성된 코드 + 핵심 설명
- 개념 질문: 명확하고 간결한 설명

[필수 부가가치 규칙 — 반드시 준수]
초안 코드가 올바르더라도 반드시 다음 중 하나 이상을 추가하세요:
1. 동작을 검증하는 테스트 코드 (정상 케이스 + 엣지케이스)
2. 실무 사용 시 주의사항 또는 한계점
3. 성능·확장성 측면의 개선 가능한 변형 제안

⚠️ "변경 없음" 또는 초안을 그대로 복사하는 것은 절대 금지입니다.`;


// ✅ Qwen 실패 시 Gemini가 직접 답변하는 단독 모드용 프롬프트
const GEMINI_SOLO_SYSTEM = `당신은 10년 이상 경력의 시니어 소프트웨어 엔지니어입니다.

[언어 규칙]
- 기본 답변 언어: 한국어
- 사용자가 "영어로 답변해" 또는 "answer in English" 라고 하면 영어로 전환
- 코드(변수명/함수명/클래스명): 항상 영어
- 코드 주석: 기본 한국어, 영어 요청 시 영어

요청에 대해 최선의 답변을 작성하세요.
- 코드 질문: 완성된 코드 + 핵심 설명 + 테스트 코드
- 개념 질문: 핵심 개념 → 실무 적용
- 엣지케이스와 주의사항 포함`;


function addReminder(message) {
  return `${message}

---
⚠️ 상기:
- [사고 과정] 반드시 수행
- 기본 답변은 한국어 (영어 요청 시에만 영어)
- 코드 변수명/함수명은 항상 영어
- 코드 주석은 기본 한국어
- 답변은 간결하게 (핵심만)`;
}


function stripThinking(text) {
  return text
    .replace(/\[사고 과정\][\s\S]*?\[\/사고 과정\]/g, '')
    .replace(/\[검토 사고 과정\][\s\S]*?\[\/검토 사고 과정\]/g, '')
    .replace(/\[답변\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
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
  'qwen/qwen3-235b-a22b:free',
  'qwen/qwen3-30b-a3b:free',
];


function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ============================================================
//  callQwen
//  ✅ 수정: 모든 모델 실패 시 throw 대신 null 반환
//  → 호출부에서 null 체크 후 Gemini 단독 폴백으로 이어짐
// ============================================================
async function callQwen(messages, apiKey, referer) {
  let lastError = null;

  for (const model of QWEN_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 55_000);

      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': referer || 'http://localhost:3000',
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: 3500,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          return data.choices[0].message.content;
        }

        const status = res.status;

        if (status === 429) {
          const waitMs = (attempt + 1) * 1500;
          lastError = `${model} — 속도 제한(429)`;
          await sleep(waitMs);
          continue;
        }

        if (status === 404 || status === 503) {
          lastError = `${model} — 사용 불가(${status})`;
          break;
        }

        lastError = `${model} — 오류(${status})`;
        return null;

      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          lastError = `${model} — 타임아웃`;
          break;
        }
        lastError = `${model} — 예외: ${err.message}`;
        break;
      }
    }
  }

  console.error(`Qwen 전체 실패: ${lastError}`);
  return null; // ✅ throw 대신 null 반환
}


// ============================================================
//  callGemini
//  ✅ 수정: maxOutputTokens 3000 → 5000
// ============================================================
async function callGemini(systemPrompt, userMessage, apiKey) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55_000);

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userMessage }] }],
            generationConfig: { maxOutputTokens: 5000 }, // ✅ 3000 → 5000
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        return data.candidates[0].content.parts[0].text;
      }

      const status = res.status;

      if (status === 429 || status === 503) {
        const waitMs = (attempt + 1) * 2000;
        await sleep(waitMs);
        continue;
      }

      const errText = await res.text();
      throw new Error(`Gemini API 오류 [${status}]: ${errText}`);

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('Gemini 타임아웃 (55초 초과)');
      }
      throw err;
    }
  }

  throw new Error('Gemini 재시도 횟수 초과');
}


// ============================================================
//  handler
// ============================================================
export default async function handler(req) {

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: '허용되지 않는 메서드' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: '잘못된 JSON 형식입니다' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { messages } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: '메시지 배열이 비어있습니다' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const inputTokens = estimateTokens(JSON.stringify(messages));

  if (inputTokens > 30_000) {
    return new Response(
      JSON.stringify({
        error: `입력이 너무 깁니다 (추정 ${inputTokens.toLocaleString()} 토큰). 대화를 새로 시작하거나 내용을 줄여주세요.`,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
  const referer            = req.headers.get('origin') || 'http://localhost:3000';
  const userMessage        = messages[messages.length - 1].content;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data) => controller.enqueue(enc.encode(sseEvent(data)));

      let pingTimer = null;
      const startPing = () => {
        pingTimer = setInterval(() => {
          try { controller.enqueue(enc.encode(': ping\n\n')); }
          catch { clearInterval(pingTimer); }
        }, 15_000);
      };
      const stopPing = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      };

      try {
        startPing();

        // -------------------------------------------------------
        //  1단계: Qwen CoT
        // -------------------------------------------------------
        send({ stage: 'qwen_start', message: '🧠 Qwen 분석 중...' });

        const qwenMessages = [
          { role: 'system', content: QWEN_SYSTEM },
          ...messages.slice(0, -1),
          { role: 'user', content: addReminder(userMessage) },
        ];

        const qwenRaw = await callQwen(qwenMessages, OPENROUTER_API_KEY, referer);

        // -------------------------------------------------------
        //  ✅ Qwen 실패 → Gemini 단독 모드 폴백
        // -------------------------------------------------------
        if (qwenRaw === null) {
          send({
            stage: 'qwen_failed',
            message: '⚠️ Qwen 모델 불가 — Gemini 단독으로 답변합니다',
          });

          const finalAnswer = await callGemini(
            GEMINI_SOLO_SYSTEM,
            userMessage,
            GEMINI_API_KEY
          );

          stopPing();
          send({
            stage: 'done',
            final: finalAnswer,
            solo_mode: true,
            tokens: { estimated_input: inputTokens },
          });

        } else {
          // -------------------------------------------------------
          //  정상 파이프라인: Qwen → Gemini 정제
          // -------------------------------------------------------
          const qwenDraft = stripThinking(qwenRaw);
          send({ stage: 'qwen_done', draft: qwenDraft });

          const pipelineTokens = estimateTokens(qwenDraft + userMessage);

          if (pipelineTokens > 80_000) {
            stopPing();
            send({
              stage: 'pipeline_limit',
              message: '⚠️ 토큰 한도 초과 — Qwen 결과만 반환합니다',
              final: qwenDraft,
            });
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          send({ stage: 'gemini_start', message: '🔍 Gemini 검토 중...' });

          const geminiInput = `원본 요청:
${userMessage}

Qwen 초안:
${qwenDraft}

위 초안을 검토하고 개선된 최종 답변만 출력해줘. 검토 과정은 출력하지 마.`;

          const finalAnswer = await callGemini(GEMINI_SYSTEM, geminiInput, GEMINI_API_KEY);

          stopPing();
          send({
            stage: 'done',
            final: finalAnswer,
            tokens: {
              estimated_input:    inputTokens,
              estimated_pipeline: pipelineTokens,
            },
          });
        }

      } catch (err) {
        stopPing();
        send({ stage: 'error', error: err.message });
      }

      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
