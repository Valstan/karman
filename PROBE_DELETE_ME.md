# Подсадные секреты для мутационной приёмки гейта

Эта ветка НЕ мержится и удаляется сразу после красного прогона.
Значения СЛУЧАЙНЫЕ и нигде не действительны — приёмка примером из документации
вендора не засчитывается (G258: такие ключи лежат в дефолтном allowlist gitleaks,
и гейт остаётся зелёным на заведомом нарушении).

Класс 1 — токен комнаты vault (правило karman-vault-room-token):
    SECRETS_TOKEN=skm_qHE_1SS_WRQYaaDu4aTdIov2SGujgcPGl8WlU3D04UU

Класс 2 — времянка (правило karman-vault-bootstrap-code):
    skb_x8kl1HJrhnHoaSUVz-q5p2D-iobWNFrJ

Класс 3 — Telegram-токен ВНУТРИ URL (правило telegram-bot-token-in-url).
Именно этот класс дефолтные 195 правил пропускают:
    curl "https://api.telegram.org/bot0597033269:AAgSubROnWHxKrcSjLBdlD_fbbp7k_1_x7E/sendMessage"
