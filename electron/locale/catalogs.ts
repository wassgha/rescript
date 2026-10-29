import type { UiLocale } from "../../lib/i18n/locales";
import { de } from "./de";
import { en, type DesktopMessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { ko } from "./ko";
import { pt } from "./pt";
import { it } from "./it";
import { zhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";

export type DesktopMessageCatalog = Record<DesktopMessageKey, string>;

export const desktopCatalogs: Record<UiLocale, DesktopMessageCatalog> = {
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
