import {ITranslation} from "@shared"
export const LANG_EN = {
    Responses: {
        BAD_REQUEST:"Hatalı istek!",
        FORBIDDEN: "Bu işlem için yetkiniz yok!",
        INTERNAL_SERVER_ERROR: "Sunucu hata verdi :(",
        NOT_FOUND: "Sayfa bulunamadı!",
        NOT_IMPLEMENTED:"Bu özellik daha kullanıma sunulmamış!",
        RATELIMIT: "Çok fazla istek yolluyorsun!",
        UNAUTHORIZED: "Bu işlem için giriş yapmalısın!",
        VALIDATION_FAILED: "İsteğinizi okuyamadık (parse error for %parse_type% %parse_key%)",
        UNKNOWN: "Bilinmeyen hata!"
    }
} as const