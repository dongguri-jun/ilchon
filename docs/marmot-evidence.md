# Marmot 릴레이 증거: 릴레이는 누가 누구에게 보내는지 알 수 없어요

ilchon 메시지가 릴레이에 어떤 모습으로 남는지 실제로 확인한 기록이에요.
`scripts/evidence-relay.ts`를 실제 릴레이에 대고 돌린 결과를 그대로 옮겼어요.

## 무엇을 했나요

- 일회용 신원 A, B를 만들어요. 앱과 같은 전송 모듈(`src/lib/marmot`)을 써요. 저장소는 메모리, 릴레이는 `DEFAULT_RELAYS`(relay.us / relay.eu.whitenoise.chat)예요.
- A가 B를 초대하고 B가 수락해요(`invitePeer` / `acceptInvite`).
- `transport.send`로 메시지 6개를 주고받아요. hello, chat 2개, 가짜 매칭 라운드 m1/m2/m3예요.
- 두 클라이언트가 소켓에 쓴 프레임을 엿봐서 발행한 이벤트 id와 그룹 라우팅 값(`#h`)을 기록해요. 전송 모듈 내부는 건드리지 않아요.
- 끝나면 **새 WebSocket을 익명으로** `wss://relay.us.whitenoise.chat`에 열어요. 인증 없이, 릴레이가 저장한 이벤트를 그대로 받아 와요.
  - kind 445: 이 그룹의 `#h` 값으로 조회, 그리고 실행 시간대의 445 전체
  - kind 1059: `#p` = B, `#p` = A
  - A·B가 서명한 30443 / 10002 / 10050
  - A·B가 작성한 모든 이벤트, A·B를 태그한 모든 이벤트

다시 돌리려면 이렇게 해요. 30초쯤 걸리고 매번 새 키를 만들어요.

```
pnpm exec tsx scripts/evidence-relay.ts
PROBE_RELAY=wss://relay.eu.whitenoise.chat pnpm exec tsx scripts/evidence-relay.ts
```

## 실제 출력 (2026-11-06 00:27 UTC 실행, 편집 없음)

내용 본문은 처음부터 출력하지 않아요. 어차피 암호문이고 길이만 적었어요. 비밀키도 출력하지 않아요.

```
probe relay : wss://relay.us.whitenoise.chat
app relays  : wss://relay.us.whitenoise.chat, wss://relay.eu.whitenoise.chat
A pubkey    : 55f7d92f5c4c134f485e019049c3fda3fad2bf0a650f502a7e582ccf9a09f8de
B pubkey    : 1502bac24bcb5a5db59145ec85b9953cb908fd7f3bde45bea217ad2ce9383138
[ok] A and B started (relay lists + KeyPackage published)
[ok] A invited B, MLS group id 6f79a55629cf7497... (never sent in clear)
[ok] B accepted
[ok] send#1 A->B hello delivered
[ok] send#2 B->A chat delivered
[ok] send#3 A->B chat delivered
[ok] send#4 A->B m1 delivered
[ok] send#5 B->A m2 delivered
[ok] send#6 A->B m3 delivered

=== frames our two clients wrote: 16 distinct events ===
  [start] kind 10002 id 352136158bcf pubkey=A
  [start] kind 10050 id 05e0b1712db4 pubkey=A
  [start] kind 30443 id 86b97f480755 pubkey=A
  [start] kind 10002 id dbc814d325fd pubkey=B
  [start] kind 10050 id 0197ad68e964 pubkey=B
  [start] kind 30443 id 37548da6be15 pubkey=B
  [invite] kind 445 id a5f1fbdb093e pubkey=other
  [invite] kind 1059 id 092924bb6945 pubkey=other
  [accept] kind 445 id 9547253b280f pubkey=other
  [send#1 A->B hello] kind 30443 id 4fe56dda8e76 pubkey=B
  [send#1 A->B hello] kind 445 id 2f0787028870 pubkey=other
  [send#2 B->A chat] kind 445 id 01fe8bb3e693 pubkey=other
  [send#3 A->B chat] kind 445 id 19361aa4039a pubkey=other
  [send#4 A->B m1] kind 445 id 423829bc7f3c pubkey=other
  [send#5 B->A m2] kind 445 id 548d59d28adf pubkey=other
  [send#6 A->B m3] kind 445 id 7fa6f3b484c0 pubkey=other
  #h values used in our REQ filters: 7fee4549b293fbeca3df28233e105a0a77d6a2fd9c27176ab32a4812cb4179ed

=== what wss://relay.us.whitenoise.chat returns to an anonymous reader ===

-- kind 445 group events (#h = our group): 8 event(s) [EOSE]
   kind 445 id a5f1fbdb093e created_at 1793924881 (t+2s) pubkey 60b0d8c04b58=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 920 chars published-by-this-run
   kind 445 id 01fe8bb3e693 created_at 1793924883 (t+4s) pubkey 78c198a1033a=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 608 chars published-by-this-run
   kind 445 id 2f0787028870 created_at 1793924883 (t+4s) pubkey 8c8fd7306486=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 632 chars published-by-this-run
   kind 445 id 9547253b280f created_at 1793924883 (t+4s) pubkey 7162b57c8245=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 940 chars published-by-this-run
   kind 445 id 19361aa4039a created_at 1793924884 (t+5s) pubkey a7c3cf4ad87a=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 608 chars published-by-this-run
   kind 445 id 548d59d28adf created_at 1793924885 (t+6s) pubkey 09a7843923eb=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 660 chars published-by-this-run
   kind 445 id 423829bc7f3c created_at 1793924885 (t+6s) pubkey b351c95c566a=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 644 chars published-by-this-run
   kind 445 id 7fa6f3b484c0 created_at 1793924886 (t+7s) pubkey 4b7e8448a96b=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 632 chars published-by-this-run

-- kind 445 in run window (any group): 9 event(s) [EOSE], 8 of them ours
   kind 445 id a5f1fbdb093e created_at 1793924881 (t+2s) pubkey 60b0d8c04b58=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 920 chars published-by-this-run
   kind 445 id 01fe8bb3e693 created_at 1793924883 (t+4s) pubkey 78c198a1033a=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 608 chars published-by-this-run
   kind 445 id 2f0787028870 created_at 1793924883 (t+4s) pubkey 8c8fd7306486=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 632 chars published-by-this-run
   kind 445 id 9547253b280f created_at 1793924883 (t+4s) pubkey 7162b57c8245=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 940 chars published-by-this-run
   kind 445 id 19361aa4039a created_at 1793924884 (t+5s) pubkey a7c3cf4ad87a=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 608 chars published-by-this-run
   kind 445 id 548d59d28adf created_at 1793924885 (t+6s) pubkey 09a7843923eb=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 660 chars published-by-this-run
   kind 445 id 423829bc7f3c created_at 1793924885 (t+6s) pubkey b351c95c566a=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 644 chars published-by-this-run
   kind 445 id 7fa6f3b484c0 created_at 1793924886 (t+7s) pubkey 4b7e8448a96b=other tags[h] tagHasA=false tagHasB=false h=7fee4549b293 content 632 chars published-by-this-run

-- kind 1059 addressed to B (#p = B): 1 event(s) [EOSE]
   kind 1059 id 092924bb6945 created_at 1793923783 (t+-1096s) pubkey 0c0208d66485=other tags[p,alt] tagHasA=false tagHasB=true p=B content 4868 chars published-by-this-run
      plain tags: alt=A gift-wrapped event

-- kind 1059 addressed to A (#p = A): 0 event(s) [EOSE]

-- A and B profile events (30443/10002/10050): 6 event(s) [EOSE]
   kind 30443 id 86b97f480755 created_at 1793924879 (t+0s) pubkey 55f7d92f5c4c=A tags[d,mls_protocol_version,i,mls_ciphersuite,mls_extensions,mls_proposals,app_components] tagHasA=false tagHasB=false content 640 chars published-by-this-run
      plain tags: mls_protocol_version=1.0  mls_ciphersuite=0x0001  mls_extensions=0x0006|0xf2d1  mls_proposals=0x4a4a|0xeaea|0x0008|0x000a  app_components=0x8001|0x8002|0x8003|0x8004|0x8005|0x8006|0x8007|0x8009|0x80
   kind 10002 id 352136158bcf created_at 1793924879 (t+0s) pubkey 55f7d92f5c4c=A tags[r,r] tagHasA=false tagHasB=false content 0 chars published-by-this-run
      plain tags: r=wss://relay.us.whitenoise.chat/  r=wss://relay.eu.whitenoise.chat/
   kind 10050 id 05e0b1712db4 created_at 1793924879 (t+0s) pubkey 55f7d92f5c4c=A tags[relay,relay] tagHasA=false tagHasB=false content 0 chars published-by-this-run
      plain tags: relay=wss://relay.us.whitenoise.chat/  relay=wss://relay.eu.whitenoise.chat/
   kind 10050 id 0197ad68e964 created_at 1793924879 (t+0s) pubkey 1502bac24bcb=B tags[relay,relay] tagHasA=false tagHasB=false content 0 chars published-by-this-run
      plain tags: relay=wss://relay.us.whitenoise.chat/  relay=wss://relay.eu.whitenoise.chat/
   kind 10002 id dbc814d325fd created_at 1793924879 (t+0s) pubkey 1502bac24bcb=B tags[r,r] tagHasA=false tagHasB=false content 0 chars published-by-this-run
      plain tags: r=wss://relay.us.whitenoise.chat/  r=wss://relay.eu.whitenoise.chat/
   kind 30443 id 4fe56dda8e76 created_at 1793924883 (t+4s) pubkey 1502bac24bcb=B tags[d,mls_protocol_version,i,mls_ciphersuite,mls_extensions,mls_proposals,app_components] tagHasA=false tagHasB=false content 640 chars published-by-this-run
      plain tags: mls_protocol_version=1.0  mls_ciphersuite=0x0001  mls_extensions=0x0006|0xf2d1  mls_proposals=0x8a8a|0xbaba|0x0008|0x000a  app_components=0x8001|0x8002|0x8003|0x8004|0x8005|0x8006|0x8007|0x8009|0x80

-- anything authored by A or B: 6 event(s) [EOSE]
   kind 30443 id 86b97f480755 created_at 1793924879 (t+0s) pubkey 55f7d92f5c4c=A tags[d,mls_protocol_version,i,mls_ciphersuite,mls_extensions,mls_proposals,app_components] tagHasA=false tagHasB=false content 640 chars published-by-this-run
      plain tags: mls_protocol_version=1.0  mls_ciphersuite=0x0001  mls_extensions=0x0006|0xf2d1  mls_proposals=0x4a4a|0xeaea|0x0008|0x000a  app_components=0x8001|0x8002|0x8003|0x8004|0x8005|0x8006|0x8007|0x8009|0x80
   kind 10002 id 352136158bcf created_at 1793924879 (t+0s) pubkey 55f7d92f5c4c=A tags[r,r] tagHasA=false tagHasB=false content 0 chars published-by-this-run
      plain tags: r=wss://relay.us.whitenoise.chat/  r=wss://relay.eu.whitenoise.chat/
   kind 10050 id 05e0b1712db4 created_at 1793924879 (t+0s) pubkey 55f7d92f5c4c=A tags[relay,relay] tagHasA=false tagHasB=false content 0 chars published-by-this-run
      plain tags: relay=wss://relay.us.whitenoise.chat/  relay=wss://relay.eu.whitenoise.chat/
   kind 10050 id 0197ad68e964 created_at 1793924879 (t+0s) pubkey 1502bac24bcb=B tags[relay,relay] tagHasA=false tagHasB=false content 0 chars published-by-this-run
      plain tags: relay=wss://relay.us.whitenoise.chat/  relay=wss://relay.eu.whitenoise.chat/
   kind 10002 id dbc814d325fd created_at 1793924879 (t+0s) pubkey 1502bac24bcb=B tags[r,r] tagHasA=false tagHasB=false content 0 chars published-by-this-run
      plain tags: r=wss://relay.us.whitenoise.chat/  r=wss://relay.eu.whitenoise.chat/
   kind 30443 id 4fe56dda8e76 created_at 1793924883 (t+4s) pubkey 1502bac24bcb=B tags[d,mls_protocol_version,i,mls_ciphersuite,mls_extensions,mls_proposals,app_components] tagHasA=false tagHasB=false content 640 chars published-by-this-run
      plain tags: mls_protocol_version=1.0  mls_ciphersuite=0x0001  mls_extensions=0x0006|0xf2d1  mls_proposals=0x8a8a|0xbaba|0x0008|0x000a  app_components=0x8001|0x8002|0x8003|0x8004|0x8005|0x8006|0x8007|0x8009|0x80

-- anything tagging A or B (#p): 1 event(s) [EOSE]
   kind 1059 id 092924bb6945 created_at 1793923783 (t+-1096s) pubkey 0c0208d66485=other tags[p,alt] tagHasA=false tagHasB=true p=B content 4868 chars published-by-this-run
      plain tags: alt=A gift-wrapped event

=== summary ===
kind 445 group events stored         : 8
  distinct signing pubkeys           : 8 (A or B: 0)
  events with A or B in any tag      : 0
  distinct h (group routing) values  : 1
kind 1059 welcome to B stored        : 1
  welcome signed by A                : 0
  welcome tags mention A             : 0
profile events (A/B signed)          : 30443:A 10002:A 10050:A 10050:B 10002:B 30443:B
messages sent through the group      : 6 application + commits
```

같은 스크립트를 바로 전에 한 번 더 돌렸을 때도 결과가 같았어요. 445 8개, 서명 키 8개 모두 A·B 아님, A·B를 담은 태그 0개, 1059 하나에만 `p=B`였어요.

## 출력을 읽는 법

- **kind 445 (그룹 메시지) 8개.** A가 B를 넣은 커밋 1개, B가 수락하며 키를 바꾼 커밋 1개, 앱 메시지 6개예요.
  - 8개 모두 **서명 키가 서로 달라요.** 메시지마다 일회용 키로 서명해요. A나 B의 키는 하나도 없어요.
  - 태그는 `h` 하나뿐이에요. 이 값은 그룹 라우팅용 무작위 id예요. MLS 그룹 id(`6f79a556...`)와도 다르고, A·B의 키도 들어 있지 않아요.
  - 그래서 릴레이는 A가 보낸 것과 B가 보낸 것을 구별하지 못해요. 같은 그룹이라는 것만 알아요.
- **kind 1059 (Welcome) 1개.** 초대할 때 한 번만 생겨요.
  - `p` 태그가 B예요. **B가 무언가에 초대받았다는 사실은 드러나요.**
  - 서명 키는 일회용이에요. A는 어디에도 없어요. `created_at`도 18분쯤 과거로 흐려져 있어요(NIP-59 방식).
  - 이 릴레이는 인증 없는 익명 조회에도 이 1059를 돌려줬어요. 릴레이 운영자뿐 아니라 누구나 볼 수 있다는 뜻이에요.
- **A·B가 직접 서명한 이벤트는 6개뿐이에요.** 10002, 10050(릴레이 목록), 30443(KeyPackage)이에요.
  - 모두 메시지를 주고받기 전에 공개하는 "나에게 연락할 수 있다"는 정보예요. 상대가 누구인지는 담지 않아요.
  - 30443 태그(`mls_ciphersuite`, `app_components` 등)를 보면 이 키가 Marmot을 쓴다는 것은 알 수 있어요.
  - B는 수락 직후 KeyPackage를 새로 발행해요(같은 `d` 슬롯이라 이전 것을 대체해요). 이 시각이 B의 수락 커밋과 몇 초 차이예요. 타이밍을 맞춰 보면 "B가 방금 어떤 그룹에 들어갔다"는 추정은 가능해요.

## 릴레이가 볼 수 있는 것과 없는 것

| 항목 | Marmot (ilchon) | NIP-17 DM (비교, 보내지 않음) |
|---|---|---|
| 메시지를 보낸 사람 | **안 보여요.** 445마다 일회용 서명 키 | 안 보여요. 1059마다 일회용 서명 키 |
| 메시지를 받는 사람 | **안 보여요.** 태그는 `h`(그룹 id)뿐 | **보여요.** 메시지마다 `p` = 받는 사람 |
| 보낸 사람 본인 | 안 보여요 | 보낸 사람용 사본 1059에 `p` = 보낸 사람. 같은 순간 발행돼 묶일 수 있어요 |
| 두 사람이 대화 중이라는 사실 | 그룹 id만 보여요. 누구의 그룹인지 몰라요 | 받는 사람별 메시지 수와 빈도가 계속 쌓여요 |
| 초대·첫 연결 | Welcome 1059 **한 번**, `p` = 초대받은 사람 | 해당 없음(메시지마다 노출) |
| 메시지 내용, 종류(chat / m1 / m2 / m3) | 안 보여요(MLS 암호문) | 안 보여요(암호문) |
| 메시지 길이 | 보여요(앱 메시지 608~660자, 커밋 920~940자) | 보여요 |
| 메시지 수와 시각 | 그룹 단위로 보여요(`created_at` 초 단위) | 받는 사람 단위로 보여요(`created_at`은 흐림, 수신 시각은 남음) |
| 연결 IP, 접속 시각, 구독 필터 | **보여요** | **보여요** |
| 이 키가 Marmot 사용자라는 것 | 보여요(30443 KeyPackage) | 보여요(10050 DM 릴레이 목록) |

NIP-17 쪽 설명의 근거예요.

- NIP-17 (https://github.com/nostr-protocol/nips/blob/master/17.md): 메시지를 받는 사람마다, 그리고 보낸 사람 자신에게도 따로 gift wrap(kind 1059)을 만들어요. 각 wrap은 `p` 태그로 받는 사람을 적어요. 받는 사람의 kind 10050 릴레이로만 보내요.
- NIP-59 (https://github.com/nostr-protocol/nips/blob/master/59.md): wrap은 일회용 키로 서명하고 `created_at`을 최대 이틀 과거로 흐려요. 하지만 `p` 태그가 받는 사람을 공개적으로 드러낸다고 스스로 밝혀요. 릴레이가 AUTH로 접근을 막아 주기를 권하지만 릴레이에 달린 일이에요.

## 정직하게 남는 것

- 릴레이는 접속 IP와 시각을 봐요. 같은 IP가 A의 30443을 올리고 그룹 `h`를 구독하면 연결될 수 있어요. Tor나 VPN 같은 네트워크 계층 보호는 ilchon 범위 밖이에요.
- 클라이언트가 자기 Welcome을 받으려면 `#p` = 자기 키로 구독해요. 그 연결은 그 키의 것이라고 릴레이가 알 수 있어요.
- Welcome은 초대받은 사람을 **한 번** 드러내요. 초대한 사람은 드러내지 않아요.
- KeyPackage(30443)는 그 키가 Marmot을 쓴다는 것을 드러내요. 상대나 거래 정보는 담지 않아요.
- 메시지 길이와 개수, 시각은 그룹 단위로 보여요. 패딩은 하지 않아요.
- 이번 측정은 relay.us 한 곳만 조회했어요. 앱은 relay.eu에도 같은 이벤트를 보내요.

## 슬라이드용 3줄 결론

1. 릴레이에 남은 ilchon 메시지 8개는 모두 일회용 키로 서명됐고, A·B의 키는 서명에도 태그에도 없었어요.
2. NIP-17 DM은 메시지마다 받는 사람을 `p` 태그로 드러내지만, Marmot은 처음 초대할 때 한 번만 드러내요.
3. 남는 건 IP·시각·메시지 길이, 그리고 "이 키는 Marmot을 쓴다"는 사실이에요.
