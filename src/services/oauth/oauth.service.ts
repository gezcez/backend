import { OAuthRepository } from "./oauth.repository"


export abstract class OAuthService {
	
	static async isUsernameOrEmailTaken(username: string, email: string) {
		const result = await OAuthRepository.getUserByEmailAndPassword(email,username)
		if (result) return false
		return true
	}
	

	static async activateUser(user_id: number) {
		const result = await OAuthRepository.activateUser(user_id)
		return result
	}
}


