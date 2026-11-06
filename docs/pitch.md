# ilchon 일촌 — 프로젝트 제출문

## 한국어

**ilchon 일촌**

**한 줄:** 직접 만난 사람하고만 비트코인을 거래하고, 내 조건은 같은 통화로 반대 방향 거래를 하려는 일촌에게만 보여요.

**문제.** 한국의 비트코인 사용자는 온라인에서 모르는 사람과 개인 거래를 많이 해요. 그런데 최근 그런 거래로 보이스피싱, 3자 사기, 자금 세탁에 연루되어 통장을 못 쓰게 된 사람이 많아요. 그래서 거래소를 쓰고 싶지 않은 사람도 결국 거래소를 쓰고 개인정보를 내놓아요. 거래소는 편해서 고르는 선택이어야지, 어쩔 수 없이 쓰는 강제가 되면 안 된다고 생각해요. 믿는 사람끼리 거래해도, 단체방에 올리면 거래하지 않을 사람까지 내가 비트코인을 판다는 걸 알게 돼요.

**해결.** 밋업에서 만나 30초마다 바뀌는 일회용 QR을 서로 찍은 사람만 일촌이 돼요. 조건(삽니다/팝니다, 원화/달러, 금액, 수수료)을 올리면 앱이 일촌 각자와 몰래 맞춰보고, 같은 통화로 방향이 반대인 일촌만 게시판에 띄워요. 금액과 수수료는 거르지 않고, 나와 금액이 가까운 순(또는 수수료가 유리한 순)으로 정렬해요. 누르면 둘만의 방이 열려요. 원화는 계좌이체로, 비트코인은 각자의 라이트닝 지갑으로 직접 주고받아요. 앱은 돈을 옮기지 않아요.

**왜 비공개인가.** ristretto255 위의 교환 가능한 블라인딩과 해시 커밋으로 "누가 누구에게 어떤 통화로 파는가"만 비교해요. 맞지 않은 일촌은 내 방향, 통화, 금액, 수수료를 알 수 없어요. 일촌 전용 서버가 없고(중계는 Marmot 릴레이), 연락처는 각자 기기에만 있어요. 키는 패스키 PRF나 NIP-49 비밀번호로 잠가요.

**왜 Marmot인가.** Marmot을 단체방이 아니라 **관계 하나 = 두 사람짜리 MLS 그룹 하나**로 썼어요. 서로 QR을 찍으면 상대의 KeyPackage(30443)로 그룹을 만들고, Welcome은 gift wrap(1059)으로 상대에게만 보내요. 들어온 쪽은 바로 자기 키를 한 번 바꿔요. 그 뒤 연결 확인, 3단계 몰래 맞춰보기, 조건, 채팅, 거래 완료가 모두 이 그룹 메시지(445) 안에서 오가요. 1:1이어도 NIP-17 DM과 달리 릴레이는 메시지마다 받는 사람을 볼 수 없어요. 그룹 메시지는 메시지마다 다른 일회용 키로 서명돼요(실측: 메시지 8개, 서명 키 8개, 멤버 키 0개). 내용 암호화 키도 메시지마다 앞으로만 바뀌어요(MLS 비밀 트리). 다만 주기적인 키 교체는 아직 없어서, 키가 털린 뒤 저절로 회복된다고는 말하지 않아요. Marmot은 중계 서버에게서 내용을 숨기고, 몰래 맞춰보기는 거래하지 않을 일촌에게서 의사를 숨겨요. 둘 다 있어야 해요. 관계가 이미 그룹이라서, 같은 방에 사람을 더하는 다음 단계가 프로토콜 차원에서 열려 있어요.

**화면과 설정.** 모든 화면의 상단 배너에서 KO/EN을 바꿀 수 있어요. 첫 설정과 잠금 해제 화면도 포함해요. 시연 모드 대신 설정 → **맞춰보기 간격**에서 **실시간 / 10초 / 1분 / 1시간 / 24시간**을 골라요. 해커톤 빌드의 새 프로필은 실시간이 기본이고, `?demo=1`은 실시간, `?demo=0`은 24시간으로 설정해요. 같은 일촌과는 간격마다 완료된 맞춰보기가 최대 한 번이에요. 짧을수록 다시 빨리 맞춰보지만 상대가 내 방향을 떠볼 기회도 늘어나므로, 24시간이 가장 안전해요.

**선택적 프로필 연결.** 서로 QR을 찍어 이미 연결한 일촌에게 npub을 붙여넣으면, 공개 릴레이에서 공개 kind-0 프로필(이름, 사진, NIP-05 확인)을 가져와 내 기기에만 보여 줘요. 상대에게 보내거나 공개하지 않고, 그 npub이 실제 그 사람 것이라는 증명도 아니에요.

**거래 안내.** 게시판의 내 조건에는 등록됨 · 확인 중 n/m · 일치 없음 · n명 일치 상태 배지, **수정/내리기** 버튼, 구매자·판매자 역할 안내가 있어요. 방의 **다음 할 일**은 구매자에게 가격 합의 → 내 라이트닝 청구서 보내기 → 법정화폐 계좌이체 → sats 도착 후 완료 표시를, 판매자에게 합의 → 계좌 공유 → 입금과 입금자 이름 일치 확인 → 상대 청구서 결제 → 완료 표시를 안내해요.

**지금 되는 것.** 실제 중계 서버 위에서 세 사용자 시나리오(연결, 맞춰보기, A는 B만 보고 C에게는 A의 조건이 전혀 가지 않음, 대화, 통화 변경, 조용한 삭제)를 e2e로 확인했어요. Galaxy S24의 Chrome에서 Google Password Manager로 패스키 잠금 생성·해제, 노트북 화면의 QR 카메라 스캔, ilchon.org와 ilchon.dongguri.org 간 휴대폰 ↔ 노트북 연결도 테스트해 성공했어요. 같은 기기 쌍에서 실시간 매칭(조건을 올린 뒤 약 2.5초), 양방향 채팅, 금액 수정 시 매칭 유지, 내리기 반영, 일부 거래 완료와 남은 금액 차감, 노스터 프로필 연결(NIP-05 확인), 휴대폰에서 만든 ncryptsec 백업을 노트북에서 복원하는 것까지 확인했어요. https://ilchon.org · 코드 https://github.com/dongguri-jun/ilchon

**한계.** 예치와 분쟁 해결이 없고, 입금된 돈의 출처를 확인하지 않고, IP를 가리지 않아요. 일촌은 맞춰보기가 시작된 것은 알 수 있어요. 통장 정지를 막아 준다고 말하지 않아요. 모르는 사람과 거래할 이유를 없애요.

**다음.** 같은 MLS 그룹에 멤버를 더하는 기능: 분쟁 때 둘이 합의한 중재자를 거래 방에 추가, 소개자와 두 사람이 함께 있는 2촌 소개 방, 내 기기 여러 대. 금액 구간과 수수료 한도를 몰래 맞춰보기에 넣기(비밀 비교). 기존 노스터 키 기반 백업과 연락처 복구.

## English

**ilchon 일촌**

**One-liner:** Trade bitcoin only with people you have met; your offer is seen only by contacts who want the other side of the trade, in the same currency.

**Problem.** Korean bitcoiners often trade P2P online with strangers, and many recently had bank accounts frozen after getting caught in voice-phishing, triangle scams or money laundering. So people who would rather avoid exchanges use one anyway and hand over personal data. An exchange should be a choice, not a necessity. Even among friends, a group-chat post tells everyone you are selling.

**Solution.** Contacts are added only by scanning each other's one-time QR (it changes every 30 s) in person. Post buy or sell, KRW or USD, amount and premium. Your app privately checks each contact and shows only those on the opposite side in the same currency. Amount and premium do not filter; the board sorts by closest amount (or best premium). Tap one to open a two-person room; fiat goes by bank transfer and sats by each person's own Lightning wallet. The app never moves money.

**Why private.** Commutative blinding over ristretto255 with a hash commitment compares only who sells to whom, in which currency. A non-matching contact never learns your side, currency, amount or fee. No ilchon server (Marmot relays carry the ciphertext); contacts stay on devices. Keys are locked with a passkey PRF or NIP-49 password.

**Why Marmot.** We use Marmot not as a group chat but as **one two-member MLS group per relationship**. Mutual QR creates the group from the peer's KeyPackage (30443); the Welcome goes only to the peer via gift wrap (1059), and the joiner rotates its leaf key right away. From then on the hello, the 3-step private matching, offers, chat and done all travel as group messages (445). Even one-to-one, unlike NIP-17 DMs, relays never see a recipient per message: each group message is signed by a fresh one-time key (measured: 8 messages, 8 signers, 0 member keys), and content keys ratchet forward per message (MLS secret tree). There are no periodic key updates yet, so we do not claim post-compromise security. Marmot hides content from relays; private matching hides intent from contacts who would not trade. You need both. Because every relationship is already a group, adding people to the same room is open at the protocol level.

**Screens and settings.** A top-banner KO/EN toggle is available on every screen, including first-run setup and unlock. Settings → **맞춰보기 간격** replaces demo mode with **실시간 / 10초 / 1분 / 1시간 / 24시간** (Live / 10 s / 1 min / 1 h / 24 h). New profiles default to Live in this hackathon build; `?demo=1` sets Live and `?demo=0` sets 24 h. Each contact gets at most one completed matching round per interval. Shorter intervals mean faster re-matching but more chances for a contact to probe your side; 24 h is the safest.

**Optional profile link.** Paste an npub for an existing contact made by mutual QR. ilchon fetches the public kind-0 profile (name, picture, NIP-05 check) from public relays and shows it on your device only. It is not sent to the contact or published, and does not prove the npub belongs to that person.

**Trade guidance.** Your board offer shows a status badge (registered · checking n/m · no match · n matches), labelled **수정/내리기** (edit/take down) buttons and buyer/seller role hints. The room's **다음 할 일** (next steps) checklist guides the buyer: agree price → send my Lightning invoice → bank-transfer fiat → mark done after sats arrive; and the seller: agree → share bank account → confirm deposit and that the sender name matches → pay their invoice → mark done.

**Works today.** A three-user end-to-end run over real relays passes: connect, match, A sees only B, C receives none of A's offer, chat, currency change, silent delete. Tested on Galaxy S24 with Chrome: passkey lock creation and unlock via Google Password Manager, camera QR scanning of a laptop screen, and phone ↔ laptop linking across ilchon.org and ilchon.dongguri.org all worked. On the same pair we also confirmed live matching (about 2.5 s after posting), two-way chat, edits that keep the match, take-down reaching the peer, partial done with the remaining amount reduced, Nostr profile linking with NIP-05 check, and an ncryptsec backup made on the phone restored on the laptop. https://ilchon.org · code https://github.com/dongguri-jun/ilchon

**Limits.** No escrow or disputes, no check on fiat origin, no IP hiding. Contacts can see when a matching round starts. It does not prevent freezes; it removes the reason to trade with strangers.

**Next.** Add members to the same MLS group: a mediator both sides agree on for disputes, a second-degree introduction room (introducer plus two people), and your own extra devices. Put amount ranges and premium limits into private matching (secure comparison). Recovery from an existing Nostr key.
