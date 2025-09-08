import { UseAuthorization } from "@common/middlewares"
import { RELOAD_SYNCED_CONFIG, SYNCED_CONFIG } from "@common/utils"
import { GezcezResponse } from "@gezcez/core"
import { Body, Controller, Get, Post, Req } from "@nestjs/common"
import { DashboardUtilsDTO } from "./utils.dto"
import { SignJWT } from "jose"
import { EmailService } from "@services/email/email.service"

@UseAuthorization({
	app_key: "dashboard",
	permission_key: "dashboard.utils",
	scope: "global",
	description: "User can access dashboard utilities"
})
@Controller("dashboard/utils")
export class DashboardUtilitiesController {
	@Get("/reload-synced-config")
	async reloadSyncedConfig(@Req() req: Request) {
		await RELOAD_SYNCED_CONFIG()
		return GezcezResponse({
			__message: "Synced config reloaded successfully."
		})
	}

   @Get("/synced-config")
   async getSyncedConfig(@Req() req: Request) {
      return GezcezResponse({
         synced_config: SYNCED_CONFIG
      })
   }


   @UseAuthorization({
      app_key: "dashboard",
      permission_key: "utils.sign-token",
      scope: "global",
      description: "User can sign JWT tokens for dashboard",
   })
   @Post("/sign-token")
   async signToken(@Req() req: Request,@Body() body: DashboardUtilsDTO.SignTokenDTO) {
      const { payload,token_secret } = body
      const token = new SignJWT(payload)
         .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
         .setIssuedAt()
         .setExpirationTime('24h')
         .sign(new TextEncoder().encode(token_secret));
      return GezcezResponse({
         token
      })
   }

   @UseAuthorization({
      app_key: "dashboard",
      permission_key: "utils.send-test-email",
      scope: "global",
      description: "User can send test email to verify email settings",
   })
   @Post("/send-test-email")
   async sendTestEmail(@Req() req: Request) {
      const {email_result,email_uuid,error,insert_result,log_result} = await EmailService.sendEmail({
         target_user_id: 1,
         target_email: "contact@phasenull.dev",
         subject: "Test Email from Gezcez",
         content: "This is a test email sent from Gezcez to verify email config.",
         type: "other"
      })
      if (error) {
         return GezcezResponse({
            __message: "Failed to send test email.",
            error
         },500)
      }
      return GezcezResponse({
         email_result,
         email_uuid,
         insert_result,
         log_result
      })
   }

}
