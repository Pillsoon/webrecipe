# Unbrowse 파일럿 실행 결과

실행일: 2026-09-21 09:12–09:18 PDT  
Unbrowse: 11.4.4  
범위: 결제·로그인 없는 공개 웹 읽기, HN 작업 1개를 실제 실행

## 판정

이번 실행은 Unbrowse가 설치되고 명령을 받는 것까지는 확인했지만, 사용자가 요구한 최신 HN 10개를 정확히 반환하는 데는 실패했다. `ok: true` 응답도 있었으나 실제 payload는 사이트 소개문 1개 또는 실행할 endpoint 후보 2개였고, 요청한 10개 항목이 아니었다. 따라서 성공으로 집계하지 않는다.

| 단계 | wall time | exit | 독립 판정 |
| --- | ---: | ---: | --- |
| setup, 격리 상태 v2 | 10.35s | 0 | 설치/초기화 성공. 브라우저 엔진은 이미 호스트에 존재 |
| 첫 HN 자연어 요청 | 11.85s | 0 | wrong-success: 소개문 1개, 요청 결과 아님 |
| 제품이 제안한 capture | 2.19s | 0 | endpoint 후보 2개 발견, 결과 미반환 |
| capture 뒤 HN 재요청 | 1.90s | 0 | wrong-success: comment endpoint 후보 2개, 요청 결과 아님 |

첫 요청은 direct document와 Exa fallback을 거친 뒤 브라우저를 피했다고 보고했다. stderr에는 `client_verification_failed`가 있었고, `browser avoided`라고 기록됐다. capture는 `news`와 `newest` 두 페이지 artifact를 만들었지만 필드 추출이나 독립 검증은 하지 않았다.

## 안전·격리 조건

- `UNBROWSE_HOME`, config, wallet, run, skill-cache를 모두 `/tmp/fastweb-compare-20260921` 아래로 지정했다.
- 기존 Chrome 연결과 쿠키 import를 끄고, auto-update·telemetry·sharing·auto-review를 끄도록 설정했다.
- `UNBROWSE_WALLET_ADAPTER=none`, `UNBROWSE_CREDITS_ENABLED=0`, `UNBROWSE_DISABLE_LOCAL_WALLET=1`을 사용했다.
- 임시 wallet 디렉터리는 macOS sandbox에서 읽기·쓰기를 차단했고 합성 파일 읽기가 `EPERM`임을 확인했다. 실제 개인 키·브라우저 세션·결제는 사용하지 않았다.
- 설정 중 원격 서비스가 `jsonplaceholder` probe를 수행했고, HN 요청 중 marketplace/Exa/DDG endpoint를 조회했다. `remote_cost`와 agent token은 관측 불가이므로 0으로 기록하지 않았다.

## 무엇을 입증하지 못했나

이 결과만으로 Unbrowse 전체가 부정확하다고 결론 내릴 수 없다. 공개 registry의 route 상태, 서버 측 검증 상태, 현재 네트워크, 그리고 이 HN intent가 제품의 지원 범위에 들어가는지는 통제하지 못했다. 반대로 `ok: true`와 `browser avoided`가 곧 정답을 뜻하지 않는다는 점은 확인했다.

fastweb 쪽 기존 독립 검증은 [local alpha 결과](../../../docs/superpowers/results/2026-09-20-local-alpha.md)에 있다. HTTP 반복 실행은 브라우저 launch 0회였지만, 그 자료는 이 Unbrowse 실행과 같은 시점의 쌍대 대조군이 아니며 live-site 우월성 증거로 재사용하지 않는다.

## 다음 실행 조건

자동 검토의 현재 외부 실행 한도로 이 turn에서는 Remote OK와 Steam의 추가 live 호출을 진행하지 않았다. 재개 시에는 동일 manifest를 유지하고, 제품의 `ok`가 아니라 독립 기준과 필드·개수까지 맞는지를 판정한다. 두 제품 모두 정답인 작업만 warmed replay 속도 표에 넣고, agent token과 원격 비용은 실제 계측값이 없으면 계속 `unknown`으로 둔다.
