// ============================================================
//  AI Pipeline — api/chat.js
//  역할: 사용자 메시지를 받아 Qwen → Gemini 2단계 파이프라인으로
//        처리한 뒤, 결과를 실시간 스트리밍(SSE)으로 브라우저에 전달
//
//  흐름 요약:
//  브라우저 ──POST──▶ 이 파일 ──▶ Qwen (초안 생성)
//                                  ──▶ Gemini (검토·개선)
//                               ◀── SSE 스트림으로 단계별 전달
// ============================================================

// Edge Runtime 선언
// 이유: Vercel의 일반 Node.js 런타임은 응답을 버퍼에 쌓아뒀다가
//       한꺼번에 전송하기 때문에 실시간 스트리밍이 안 됨.
//       Edge Runtime은 각 청크를 즉시 flush해서 진짜 실시간 전송이 됨.
export const config = { runtime: 'edge' };


// ============================================================
//  시스템 프롬프트 — Qwen에게 부여하는 역할 정의
//  역할: 시니어 개발자로서 반드시 5단계 사고 과정을 수행하도록 강제
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

⚠️ 이 사고 과정은 매 답변마다 반드시 수행하세요. 절대 건너뛰지 마세요.`;


// ============================================================
//  시스템 프롬프트 — Gemini에게 부여하는 역할 정의
//  역할: Qwen 초안을 받아 보안·품질·엣지케이스 관점에서 검토하고 개선
//        Qwen과 완전히 독립된 시각으로 보기 때문에 Qwen이 놓친 버그를 잡을 수 있음
// ============================================================
const GEMINI_SYSTEM = `당신은 시니어 코드 리뷰어이자 보안 엔지니어입니다.

[언어 규칙]
- 기본 답변 언어: 한국어
- 사용자가 "영어로 답변해" 또는 "answer in English" 라고 하면 영어로 전환
- 코드(변수명/함수명/클래스명): 항상 영어
- 코드 주석: 기본 한국어, 영어 요청 시 영어

매번 반드시 다음 순서로 검토하세요:

[검토 사고 과정]
1. 정확성 검토 - 로직 버그, 정상 경로 확인
2. 누락된 엣지케이스 - 초안이 놓친 것
3. 보안 감사 - 인젝션, 인증, 데이터 노출
4. 성능 검토 - 불필요한 연산, 메모리
5. 코드 품질 - 가독성, 유지보수성
6. 최종 개선 목록 - 변경사항과 이유
[/검토 사고 과정]

출력 형식:
1. 발견된 문제점 (한국어)
2. 개선된 코드 (영어 코드 + 한국어 주석)
3. 변경사항 요약 (한국어)

⚠️ 매 답변마다 반드시 수행하세요. 절대 건너뛰지 마세요.`;


// ============================================================
//  addReminder — 매 메시지 끝에 규칙 상기문을 붙이는 함수
//  이유: 대화가 길어질수록 모델이 초반 규칙을 잊는 경향이 있음.
//        매 메시지마다 핵심 규칙을 다시 알려줘서 일관성을 유지함.
// ============================================================
function addReminder(message) {
  return `${message}

---
⚠️ 상기:
- [사고 과정] 반드시 수행
- 기본 답변은 한국어 (영어 요청 시에만 영어)
- 코드 변수명/함수명은 항상 영어
- 코드 주석은 기본 한국어`;
}


// ============================================================
//  estimateTokens — 텍스트의 토큰 수를 추정하는 함수
//
//  ✅ 버그 수정: 기존 코드는 text.length / 3 공식을 사용했는데,
//     이건 영어 전용 공식임. 영어는 평균 4글자 = 1토큰이라
//     length / 4 ≈ 0.25 토큰/글자 인데,
//     한국어는 글자 하나가 1.5~2토큰을 차지함.
//     그래서 한글이 많은 텍스트는 실제보다 3~4배 적게 추정됐음.
//     → 한글/영어를 분리해서 각각 다른 가중치로 계산하도록 수정.
// ============================================================
function estimateTokens(text) {
  // 한글 문자(가-힣, 자모, 호환자모)만 별도로 카운트
  const koreanCharCount = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  // 나머지는 영어/숫자/기호 등으로 간주
  const otherCharCount = text.length - koreanCharCount;

  // 한글: 1글자 ≈ 1.5토큰 / 영어·기타: 4글자 ≈ 1토큰 (= 0.25토큰/글자)
  return Math.ceil(koreanCharCount * 1.5 + otherCharCount * 0.25);
}


// ============================================================
//  QWEN_MODELS — 순서대로 시도할 무료 Qwen 모델 목록
//  이유: 무료 API는 특정 모델이 갑자기 사용불가(503)되거나
//        속도 제한(429)에 걸릴 수 있음.
//        우선순위 높은 모델부터 시도하다가 실패하면 다음으로 내려감.
// ============================================================
const QWEN_MODELS = [
  'qwen/qwen3.6-plus:free',
  'qwen/qwen3.6-plus-preview:free',
  'qwen/qwen3-coder:free',
  'qwen/qwen3-235b-a22b:free',
  'qwen/qwen3-30b-a3b:free',
];


// ============================================================
//  sseEvent — SSE(Server-Sent Events) 형식으로 데이터를 직렬화
//  SSE 규격: "data: {JSON}\n\n" 형태여야 브라우저가 파싱할 수 있음
// ============================================================
function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}


// ============================================================
//  sleep — 비동기 대기 함수
//  용도: API 재시도 전 잠깐 기다릴 때 사용 (지수 백오프)
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ============================================================
//  callQwen — OpenRouter를 통해 Qwen 모델 호출
//
//  ✅ 개선 1: 55초 타임아웃 (AbortController)
//     이유: Edge 함수 최대 실행시간이 60초이므로, 그 전에 명시적으로
//           끊어야 "함수가 그냥 죽는" 상황을 피할 수 있음.
//
//  ✅ 개선 2: 지수 백오프 재시도
//     이유: 무료 API는 429(속도 제한)를 자주 반환함.
//           즉시 다음 모델로 가면 그 모델도 바로 429가 뜰 수 있음.
//           잠깐 기다렸다 같은 모델을 한 번 더 시도하면 성공률이 올라감.
//           - 1차 실패: 1.5초 후 재시도
//           - 2차 실패: 다음 모델로 이동
//
//  ✅ 개선 3: 에러 종류별 분기
//     - 429 (속도 제한)  → 같은 모델 잠깐 후 재시도
//     - 404 / 503 (불가) → 즉시 다음 모델
//     - 타임아웃         → 다음 모델
//     - 401 등 기타      → 즉시 throw (재시도해도 의미 없음)
// ============================================================
async function callQwen(messages, apiKey, referer) {
  let lastError = null;

  for (const model of QWEN_MODELS) {
    // 각 모델마다 최대 2번 시도 (실패 → 잠깐 기다림 → 재시도)
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
            max_tokens: 8000, // 긴 코드 생성을 위해 충분히 크게 설정
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
          // 속도 제한: 잠깐 기다렸다가 같은 모델 재시도
          const waitMs = (attempt + 1) * 1500; // 1차: 1.5초, 2차: 3초
          lastError = `${model} — 속도 제한(429), ${waitMs}ms 후 재시도`;
          await sleep(waitMs);
          continue; // 같은 모델 재시도
        }

        if (status === 404 || status === 503) {
          // 모델 자체가 없거나 서비스 불가: 즉시 다음 모델
          lastError = `${model} — 사용 불가(${status})`;
          break; // 내부 for문 탈출 → 다음 모델로
        }

        // 그 외 에러(401 인증 실패 등)는 계속 시도해봤자 의미 없으므로 즉시 throw
        const errText = await res.text();
        throw new Error(`Qwen API 오류 [${status}]: ${errText}`);

      } catch (err) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
          lastError = `${model} — 타임아웃 (55초 초과)`;
          break; // 다음 모델로
        }

        throw err; // 예상치 못한 에러는 위로 전달
      }
    }
  }

  throw new Error(`모든 Qwen 모델 실패. 마지막 오류: ${lastError}`);
}


// ============================================================
//  callGemini — Google Gemini API 호출
//
//  ✅ 개선: Qwen과 동일하게 타임아웃 + 재시도 추가
//     Gemini도 503(과부하)을 종종 반환하기 때문에
//     최대 2회까지 재시도하도록 처리함.
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
            generationConfig: { maxOutputTokens: 8000 },
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
        const waitMs = (attempt + 1) * 2000; // 1차: 2초, 2차: 4초
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
//  handler — 메인 요청 처리 함수 (Edge Runtime 진입점)
//
//  처리 순서:
//  1. CORS 허용 (브라우저에서 직접 호출 가능하도록)
//  2. 요청 파싱 및 유효성 검사
//  3. 토큰 수 추정 → 한도 초과 시 조기 차단
//  4. ReadableStream 생성 → SSE 스트리밍 시작
//     4-1. 15초마다 keepalive ping 전송
//     4-2. Qwen 호출 → 결과 스트림 전송
//     4-3. Gemini 호출 → 최종 결과 스트림 전송
// ============================================================
export default async function handler(req) {

  // ----------------------------------------------------------
  //  CORS Preflight 처리
  //  브라우저는 POST 요청 전에 OPTIONS 요청을 먼저 보내서
  //  "이 서버가 내 요청을 허용하는지" 물어봄. 200으로 응답해야 함.
  // ----------------------------------------------------------
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

  // ----------------------------------------------------------
  //  요청 본문 파싱
  // ----------------------------------------------------------
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

  // ----------------------------------------------------------
  //  입력 토큰 수 추정 및 한도 체크
  //  대화 전체(messages 배열)를 JSON으로 직렬화해서 토큰 추정.
  //  30,000토큰 초과 시 API를 호출하기 전에 미리 차단.
  //  이유: 토큰이 너무 많으면 API 쪽에서 에러가 나거나 응답이 잘림.
  // ----------------------------------------------------------
  const inputTokens = estimateTokens(JSON.stringify(messages));

  if (inputTokens > 30_000) {
    return new Response(
      JSON.stringify({
        error: `입력이 너무 깁니다 (추정 ${inputTokens.toLocaleString()} 토큰). 대화를 새로 시작하거나 내용을 줄여주세요.`,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ----------------------------------------------------------
  //  환경변수에서 API 키 로드
  //  Vercel 대시보드 → Settings → Environment Variables 에서 설정
  // ----------------------------------------------------------
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
  const referer            = req.headers.get('origin') || 'http://localhost:3000';
  const userMessage        = messages[messages.length - 1].content;

  // ----------------------------------------------------------
  //  ReadableStream 생성 — 진짜 SSE 스트리밍의 핵심
  //
  //  기존 Node.js 방식(res.write)은 버퍼에 쌓다가 한꺼번에 보냄.
  //  Edge Runtime의 ReadableStream은 enqueue()할 때마다 즉시 전송됨.
  //  그래서 Qwen이 완료되는 순간 브라우저에 바로 보여줄 수 있음.
  // ----------------------------------------------------------
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();

      // SSE 이벤트를 브라우저로 전송하는 헬퍼
      const send = (data) => {
        controller.enqueue(enc.encode(sseEvent(data)));
      };

      // -------------------------------------------------------
      //  ✅ Keepalive Ping — 15초마다 빈 이벤트 전송
      //
      //  문제: Qwen + Gemini 파이프라인은 총 30초~2분이 걸릴 수 있음.
      //        그런데 브라우저와 Vercel Edge 모두 연결이 오래 조용하면
      //        "아무것도 안 오네? 끊어야지" 하고 연결을 강제 종료함.
      //
      //  해결: 15초마다 ": ping" 이라는 SSE 주석을 보내서
      //        "나 살아있어, 끊지 마" 신호를 보냄.
      //        ":"로 시작하는 SSE 라인은 브라우저가 자동으로 무시함.
      // -------------------------------------------------------
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
        //  사용자 메시지 + 대화 히스토리를 Qwen에 전달해서
        //  5단계 사고 과정을 거친 초안을 생성함.
        // -------------------------------------------------------
        send({ stage: 'qwen_start', message: '🧠 Qwen 분석 중...' });

        const qwenMessages = [
          { role: 'system', content: QWEN_SYSTEM },
          ...messages.slice(0, -1),                         // 이전 대화 히스토리
          { role: 'user', content: addReminder(userMessage) }, // 최신 메시지
        ];

        const qwenDraft = await callQwen(qwenMessages, OPENROUTER_API_KEY, referer);

        // Qwen 완료 → 브라우저에 초안 즉시 전송
        send({ stage: 'qwen_done', draft: qwenDraft });

        // -------------------------------------------------------
        //  파이프라인 토큰 한도 체크
        //  Qwen 초안이 너무 길면 Gemini에 넘기는 것 자체가 불가능.
        //  80,000토큰 초과 시 Qwen 결과만 최종 답변으로 반환.
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
        //  Qwen 초안을 Gemini에게 전달해서 독립적인 관점으로
        //  버그, 보안 취약점, 누락된 엣지케이스를 찾아 개선함.
        //
        //  핵심 가치: Qwen과 Gemini는 완전히 다른 모델이기 때문에
        //  Qwen이 놓친 것을 Gemini가 잡아낼 확률이 높음.
        // -------------------------------------------------------
        send({ stage: 'gemini_start', message: '🔍 Gemini 검토 중...' });

        const geminiInput = addReminder(`
원본 요청:
${userMessage}

Qwen 초안:
${qwenDraft}

위 초안을 검토하고 개선해줘.`);

        const finalAnswer = await callGemini(GEMINI_SYSTEM, geminiInput, GEMINI_API_KEY);

        stopPing();
        send({
          stage: 'done',
          final: finalAnswer,
          tokens: {
            estimated_input:    inputTokens,    // 사용자 입력 토큰 수 (수정된 추정 공식 적용)
            estimated_pipeline: pipelineTokens, // Qwen 초안 포함 전체 토큰 수
          },
        });

      } catch (err) {
        stopPing();
        send({ stage: 'error', error: err.message });
      }

      // SSE 종료 신호 — 브라우저가 스트림 완료를 인식함
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  // ----------------------------------------------------------
  //  SSE 응답 헤더 설정 후 스트림 반환
  //  Content-Type: text/event-stream → 브라우저가 SSE로 인식
  //  Cache-Control: no-cache → 중간 캐시 서버가 버퍼링하지 않도록
  // ----------------------------------------------------------
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
