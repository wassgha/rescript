import { en, type MessageKey } from "./messages/en";
import { de } from "./messages/de";
import { es } from "./messages/es";
import { fr } from "./messages/fr";
import { ja } from "./messages/ja";
import { ko } from "./messages/ko";
import { pt } from "./messages/pt";
import { it } from "./messages/it";
import { zhCN } from "./messages/zh-CN";
import { zhTW } from "./messages/zh-TW";
import type { UiLocale } from "./locales";

export type MessageCatalog = Record<MessageKey, string>;

export const catalogs: Record<UiLocale, MessageCatalog> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
  es,
  fr,
  de,
  pt,
  it,
};
