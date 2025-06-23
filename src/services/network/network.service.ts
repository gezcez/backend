import { eq } from "drizzle-orm";
import { networksTable } from "../../schema/networks";
import { db } from "../../util";
import { usersTable } from "../../schema/users";

export abstract class NetworkService {
	static async createNetwork() {
		
	}
}