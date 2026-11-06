# ilchon 일촌 — 프로젝트 제출문

## 한국어

**ilchon 일촌**

**한 줄:** 직접 만난 사람하고만 비트코인을 거래하고, 내 거래 의사는 거래가 성립하는 사람에게만 보여요.

**문제.** 한국의 비트코인 사용자는 온라인에서 모르는 사람과 개인 거래를 많이 해요. 그런데 최근 그런 거래로 보이스피싱, 3자 사기, 자금 세탁에 연루되어 통장을 못 쓰게 된 사람이 많아요. 그래서 거래소를 쓰고 싶지 않은 사람도 결국 거래소를 쓰고 개인정보를 내놓아요. 거래소는 편해서 고르는 선택이어야지, 어쩔 수 없이 쓰는 강제가 되면 안 된다고 생각해요. 믿는 사람끼리 거래해도, 단체방에 올리면 거래하지 않을 사람까지 내가 비트코인을 판다는 걸 알게 돼요.

**해결.** 밋업에서 만나 30초짜리 일회용 QR을 서로 찍은 사람만 일촌이 돼요. 조건(삽니다/팝니다, 원화/달러, 금액, 수수료)을 올리면 앱이 일촌 각자와 몰래 맞춰보고, 방향이 반대인 일촌만 게시판에 띄워요. 누르면 둘만의 방이 열리고 라이트닝으로 거래해요.

**왜 비공개인가.** ristretto255 위의 교환 가능한 블라인딩과 해시 커밋으로 "누가 누구에게 어떤 통화로 파는가"만 비교해요. 맞지 않은 일촌은 내가 같은 방향인지, 조건을 안 올렸는지 구분하지 못해요. 서버가 없고, 연락처는 각자 기기에만 있어요. 키는 패스키 PRF나 NIP-49 비밀번호로 잠가요.

**왜 Marmot인가.** Marmot은 중계 서버에게서 내용을 숨기고, 몰래 맞춰보기는 거래하지 않을 일촌에게서 의사를 숨겨요. 둘 다 있어야 해요. 전화번호 없는 신원과 메시지마다 바뀌는 일회용 키를 그대로 써요.

**지금 되는 것.** 실제 중계 서버 위에서 세 사용자 시나리오(연결, 맞춰보기, A는 B만 보고 C는 아무것도 못 봄, 대화, 방향 변경, 조용한 삭제)를 e2e로 확인했어요. https://ilchon.dongguri.org

**한계.** 예치와 분쟁 해결이 없고, 입금된 돈의 출처를 확인하지 않고, IP를 가리지 않아요. 통장 정지를 막아 준다고 말하지 않아요. 모르는 사람과 거래할 이유를 없애요.

**다음.** 2촌 확장, 기존 노스터 키 기반 백업과 연락처 복구, 실기기 패스키 검증.

## English

**ilchon 일촌**

**One-liner:** Trade bitcoin only with people you have met, and show your offer only to those who would take the other side.

**Problem.** Korean bitcoiners often trade P2P online with strangers, and many recently had bank accounts frozen after getting caught in voice-phishing, triangle scams or money laundering. So people who would rather avoid exchanges use one anyway and hand over personal data. An exchange should be a choice, not a necessity. Even among friends, a group-chat post tells everyone you are selling.

**Solution.** Contacts are added only by scanning each other's 30-second one-time QR in person. Post buy or sell, KRW or USD, amount and premium. Your app privately checks each contact and shows only those on the opposite side. Tap one to open a two-person room and settle over Lightning.

**Why private.** Commutative blinding over ristretto255 with a hash commitment compares only who sells to whom, in which currency. A non-matching contact cannot tell "same side" from "no offer". No server; contacts stay on devices. Keys are locked with a passkey PRF or NIP-49 password.

**Why Marmot.** Marmot hides content from relays; private matching hides intent from contacts who would not trade. You need both. We reuse its phone-free identity and per-message one-time keys.

**Works today.** A three-user end-to-end run over real relays passes: connect, match, A sees only B, C sees nothing, chat, side change, silent delete. https://ilchon.dongguri.org

**Limits.** No escrow or disputes, no check on fiat origin, no IP hiding. It does not prevent freezes; it removes the reason to trade with strangers.

**Next.** Second-degree contacts, recovery from an existing Nostr key, real-device passkey tests.
