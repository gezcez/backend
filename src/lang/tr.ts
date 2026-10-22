// tr.ts
// Turkish strings (siz register) for emails and other server-rendered text.

import type { LangKey } from "./en"

export const tr: Record<LangKey, string> = {
	"email.footer":
		"gezcez, herkes için toplu taşıma. Bu e-postayı, bu adres gezcez'de kullanıldığı için aldınız.",
	"email.ignore": "Bu işlemi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.",
	"email.code_valid": "Kod {minutes} dakika geçerlidir.",
	"email.signin_code.subject": "gezcez giriş kodunuz: {code}",
	"email.signin_code.title": "gezcez'e giriş yapın",
	"email.signin_code.intro": "Giriş yapmak için bu kodu kullanın:",
	"email.signup_code.subject": "gezcez kayıt kodunuz: {code}",
	"email.signup_code.title": "gezcez hesabınızı oluşturun",
	"email.signup_code.intro": "Hesabınızı oluşturmayı tamamlamak için bu kodu kullanın:",
	"email.reauth_code.subject": "Kimliğinizi doğrulayın: {code}",
	"email.reauth_code.title": "Kimliğinizi doğrulayın",
	"email.reauth_code.intro": "Hesabınızdaki hassas bir işlemi onaylamak için bu kodu kullanın:",
	"email.reset_code.subject": "gezcez şifre sıfırlama kodunuz: {code}",
	"email.reset_code.title": "Şifrenizi sıfırlayın",
	"email.reset_code.intro": "Yeni bir şifre belirlemek için bu kodu kullanın:",
	"email.reset_unavailable.subject": "Şifre sıfırlama isteği",
	"email.reset_unavailable.title": "Şifre sıfırlama isteği",
	"email.reset_unavailable.intro":
		"Bu adres için şifre sıfırlama istendi, ancak sıfırlanacak bir şifre yok. E-postanıza gönderilen bir kodla her zaman giriş yapabilirsiniz.",
	"email.password_changed.subject": "gezcez şifreniz değiştirildi",
	"email.password_changed.title": "Şifre değiştirildi",
	"email.password_changed.intro":
		"gezcez hesabınızın şifresi az önce değiştirildi ve diğer tüm oturumlar kapatıldı. Bu işlemi siz yapmadıysanız hemen şifrenizi sıfırlayın ve info@gezcez.com adresine yazın.",
	"email.change_email_code.subject": "Yeni gezcez e-postanızı onaylayın: {code}",
	"email.change_email_code.title": "Yeni e-posta adresinizi onaylayın",
	"email.change_email_code.intro":
		"Bu adresi gezcez hesabınızın e-postası yapmak için bu kodu kullanın:",
	"email.email_changed.subject": "gezcez e-posta adresiniz değiştirildi",
	"email.email_changed.title": "E-posta adresi değiştirildi",
	"email.email_changed.intro":
		"gezcez hesabınızın e-posta adresi {email} olarak değiştirildi. Bu işlemi siz yapmadıysanız {security_url} adresinden hesap güvenliğinizi kontrol edin ve info@gezcez.com ile iletişime geçin.",
	"email.deletion_scheduled.subject": "gezcez hesabınız silinecek",
	"email.deletion_scheduled.title": "Hesap silme planlandı",
	"email.deletion_scheduled.intro":
		"gezcez hesabınız ve verileriniz {delete_at} tarihinde silinecek. Tüm oturumlar kapatıldı. Fikrinizi değiştirdiyseniz bu tarihten önce giriş yapıp {cancel_url} adresinden silmeyi iptal edebilirsiniz.",
	"email.export_ready.subject": "gezcez veri dışa aktarımınız hazır",
	"email.export_ready.title": "Veri dışa aktarımınız hazır",
	"email.export_ready.intro":
		"İstediğiniz gezcez veri kopyası hazır. {expires_at} tarihinden önce {download_url} adresinden indirin; bu tarihten sonra silinir.",
}
