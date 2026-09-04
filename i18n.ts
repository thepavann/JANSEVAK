/** Lightweight multilingual support for the citizen experience. */

export const LANGUAGES = [
  { code: "en", label: "English", speech: "en-IN" },
  { code: "te", label: "తెలుగు (Telugu)", speech: "te-IN" },
  { code: "hi", label: "हिन्दी (Hindi)", speech: "hi-IN" },
] as const;

export type LangCode = (typeof LANGUAGES)[number]["code"];

type Dict = Record<string, string>;

const STRINGS: Record<LangCode, Dict> = {
  en: {
    tagline: "See something? Make it count.",
    heroSupport:
      "Report civic problems with evidence. CivicLens uses AI to understand, connect and prioritize them.",
    report: "Report an issue",
    speak: "Speak",
    nearby: "View nearby issues",
    whatsHappening: "What's happening?",
    descPlaceholder: "e.g. Large pothole near a school. Two bikes nearly fell yesterday.",
    addPhoto: "Add photo",
    useLocation: "Use my location",
    analyze: "Analyze with CivicLens AI",
    photoStep: "Photo evidence",
    descStep: "Description",
    locStep: "Location",
    listening: "Listening…",
    submit: "Submit report",
  },
  te: {
    tagline: "ఏదైనా చూశారా? దానిని లెక్కలోకి తీసుకురండి.",
    heroSupport:
      "సాక్ష్యంతో పౌర సమస్యలను నివేదించండి. CivicLens AI వాటిని అర్థం చేసుకుని, కలిపి, ప్రాధాన్యత ఇస్తుంది.",
    report: "సమస్యను నివేదించండి",
    speak: "మాట్లాడండి",
    nearby: "దగ్గరలోని సమస్యలు",
    whatsHappening: "ఏమి జరుగుతోంది?",
    descPlaceholder: "ఉదా: రోడ్డు మీద పెద్ద గుంత ఉంది. స్కూల్ దగ్గర ఉంది.",
    addPhoto: "ఫోటో జోడించండి",
    useLocation: "నా లొకేషన్ ఉపయోగించండి",
    analyze: "CivicLens AI తో విశ్లేషించండి",
    photoStep: "ఫోటో సాక్ష్యం",
    descStep: "వివరణ",
    locStep: "లొకేషన్",
    listening: "వింటున్నాను…",
    submit: "నివేదికను సమర్పించండి",
  },
  hi: {
    tagline: "कुछ दिखा? उसे मायने दें।",
    heroSupport:
      "सबूत के साथ नागरिक समस्याएँ दर्ज करें। CivicLens AI उन्हें समझता, जोड़ता और प्राथमिकता देता है।",
    report: "समस्या दर्ज करें",
    speak: "बोलें",
    nearby: "आसपास की समस्याएँ",
    whatsHappening: "क्या हो रहा है?",
    descPlaceholder: "उदा: सड़क पर बड़ा गड्ढा है, स्कूल के पास।",
    addPhoto: "फ़ोटो जोड़ें",
    useLocation: "मेरा स्थान इस्तेमाल करें",
    analyze: "CivicLens AI से विश्लेषण करें",
    photoStep: "फ़ोटो सबूत",
    descStep: "विवरण",
    locStep: "स्थान",
    listening: "सुन रहा हूँ…",
    submit: "रिपोर्ट भेजें",
  },
};

const KEY = "civiclens.lang";

export function getLang(): LangCode {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(KEY);
  return (LANGUAGES.some((l) => l.code === stored) ? stored : "en") as LangCode;
}

export function setLang(code: LangCode) {
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, code);
}

export function t(lang: LangCode, key: string): string {
  return STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}

export function speechLocale(lang: LangCode): string {
  return LANGUAGES.find((l) => l.code === lang)?.speech ?? "en-IN";
}
