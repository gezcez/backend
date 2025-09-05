import { IsObject, IsString } from "class-validator";

export namespace DashboardUtilsDTO {
   export class SignTokenDTO {
      @IsObject()
      payload: any

      @IsString()
      token_secret:string
   }
}