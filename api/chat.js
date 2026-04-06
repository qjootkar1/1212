// ============================================================
//  AI Pipeline — api/chat.js
//  역할: 사용자 메시지를 받아 Qwen → Gemini 2단계 파이프라인으로
//        처리한 뒤, 결과를 실시간 스트리밍(SSE)으로 브라우저에 전달
//
//  흐름 요약:
//  브라우저 ──POST──▶ 이 파일 ──▶ Qwen (초안 생성)
//                                  ──▶ Gemini (검토·개선)
//                               ◀── SSE 스트림으로 단계별 전달
//
//  ✅ 수정 이력:
//  - Qwen max_tokens 8000 → 3500 (응답 길이 제한)
//  - Gemini 전달 전 [사고 과정] 블록 제거 (토큰 절약 + 컨텍스트 오염 방지)
//  - Gemini 시스템 프롬프트 변경: 리뷰 과정 노출 X, 최종 답변만 출력
//  - Gemini 프롬프트에 "반드시 부가가치 추가" 지시 추가 (초안 통과 방지)
// ============================================================

export const config = { runtime: 'edge' };


// ============================================================
//  시스템 프롬프트 — Qwen
//  ✅ 수정: "간결하게" 지시 추가 — 불필요하게 긴 답변 방지
// ============================================================
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


// ============================================================
//  시스템 프롬프트 — Gemini
//  ✅ 수정: 내부 검토 과정을 출력하지 말고 최종 답변만 출력하도록 변경
//  이유: 기존엔 Gemini가 "발견된 문제점 / 개선된 코드 / 변경사항 요약"
//        형식으로 출력해서 사용자 입장에서 읽기 불편했음.
//        최종 답변만 깔끔하게 출력하도록 변경.
// ============================================================
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
3. 성능·확장성 측면의 개선 가능한 변형 제안 (예: thread-safe 버전, TTL 추가 등)

⚠️ "변경 없음" 또는 초안을 그대로 복사하는 것은 절대 금지입니다.
   반드시 초안보다 실용적으로 더 가치 있는 답변을 만들어야 합니다.`;


// ============================================================
//  addReminder — 매 메시지 끝에 규칙 상기문 추가
// ============================================================
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


// ============================================================
//  stripThinking — Gemini 전달 전 [사고 과정] 블록 제거
//
//  ✅ 신규 추가
//  이유 3가지:
//  1. 토큰 절약: [사고 과정]은 평균 500~2000 토큰. 제거하면
//     Gemini 컨텍스트 여유가 생겨서 컨텍스트 초과로 스킵되는 문제 해결.
//  2. 컨텍스트 오염 방지: Gemini가 사고 과정을 "답변"으로 오해해서
//     중복 설명하거나 포맷을 따라하는 현상 방지.
//  3. 정제 품질 향상: 핵심 답변만 보여주면 Gemini가 더 정확히 개선 가능.
// ============================================================
function stripThinking(text) {
  // [사고 과정] ... [/사고 과정] 블록 제거 (줄바꿈 포함)
  return text
    .replace(/\[사고 과정\][\s\S]*?\[\/사고 과정\]/g, '')
    // [검토 사고 과정] 블록도 혹시 있으면 제거
    .replace(/\[검토 사고 과정\][\s\S]*?\[\/검토 사고 과정\]/g, '')
    // [답변] 태그가 있으면 제거 (내용은 유지)
    .replace(/\[답변\]/g, '')
    // 3줄 이상 연속 빈 줄 → 2줄로 정리
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// ============================================================
//  estimateTokens — 텍스트 토큰 수 추정 (한글/영어 분리 계산)
// ============================================================
function estimateTokens(text) {
  const koreanCharCount = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  const otherCharCount = text.length - koreanCharCount;
  return Math.ceil(koreanCharCount * 1.5 + otherCharCount * 0.25);
}


// ============================================================
//  QWEN_MODELS — 순서대로 시도할 무료 Qwen 모델 목록
// ============================================================
const QWEN_MODELS = [
  'qwen/qwen3.6-plus:free',
  'qwen/qwen3.6-plus-preview:free',
  'qwen/qwen3-coder:free',
  'qwen/qwen3-235b-a22b:free',
  'qwen/qwen3-30b-a3b:free',
];


// ============================================================
//  sseEvent — SSE 형식 직렬화
// ============================================================
function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}


// ============================================================
//  sleep — 비동기 대기
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ============================================================
//  callQwen — Qwen 모델 호출
//  ✅ 수정: max_tokens 8000 → 3500
//  이유: 8000 토큰이면 A4 10장 분량. 코딩 답변에 불필요하게 길었음.
//        3500으로 줄이면 응답 속도 향상 + Gemini 전달 토큰 절약.
//        필요 시 사용자가 "더 자세히"라고 요청하면 됨.
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
            max_tokens: 3500, // ✅ 8000 → 3500으로 축소
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
          lastError = `${model} — 속도 제한(429), ${waitMs}ms 후 재시도`;
          await sleep(waitMs);
          continue;
        }

        if (status === 404 || status === 503) {
          lastError = `${model} — 사용 불가(${status})`;
          break;
        }

        const errText = await res.text();
        throw new Error(`Qwen API 오류 [${status}]: ${errText}`);

      } catch (err) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
          lastError = `${model} — 타임아웃 (55초 초과)`;
          break;
        }

        throw err;
      }
    }
  }

  throw new Error(`모든 Qwen 모델 실패. 마지막 오류: ${lastError}`);
}


// ============================================================
//  callGemini — Gemini API 호출
//  ✅ 수정: maxOutputTokens 8000 → 3000
//  이유: Gemini는 정제 역할이므로 Qwen보다 짧아야 정상.
//        긴 출력은 Gemini가 초안을 과잉 확장하는 신호임.
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
            generationConfig: { maxOutputTokens: 3000 }, // ✅ 8000 → 3000으로 축소
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
//  handler — 메인 요청 처리 함수
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

      const send = (data) => {
        controller.enqueue(enc.encode(sseEvent(data)));
      };

      let pingTimer = null;

      const startPing = () => {
        pingTimer = setInterval(() => {
          try {
            controller.enqueue(enc.encode(': ping\n\n'));
          } catch {
            clearInterval(pingTimer);
          }
        }, 15_000);
      };

      const stopPing = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
      };

      try {
        startPing();

        // -------------------------------------------------------
        //  1단계: Qwen CoT (초안 생성)
        // -------------------------------------------------------
        send({ stage: 'qwen_start', message: '🧠 Qwen 분석 중...' });

        const qwenMessages = [
          { role: 'system', content: QWEN_SYSTEM },
          ...messages.slice(0, -1),
          { role: 'user', content: addReminder(userMessage) },
        ];

        const qwenRaw = await callQwen(qwenMessages, OPENROUTER_API_KEY, referer);

        // ✅ 사용자에게 보여줄 때도 사고 과정 제거 (선택: 보여주고 싶으면 qwenRaw 사용)
        const qwenDraft = stripThinking(qwenRaw);

        send({ stage: 'qwen_done', draft: qwenDraft });

        // -------------------------------------------------------
        //  파이프라인 토큰 한도 체크
        //  ✅ 수정: stripThinking 적용 후 토큰 계산 (더 정확한 측정)
        // -------------------------------------------------------
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

        // -------------------------------------------------------
        //  2단계: Gemini CoT (검토 및 개선)
        //  ✅ 수정: stripThinking 적용된 qwenDraft 전달
        //  → 사고 과정 없이 핵심 답변만 Gemini에 전달
        // -------------------------------------------------------
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
