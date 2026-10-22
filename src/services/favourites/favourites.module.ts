// favourites.module.ts

import { Module } from "@nestjs/common"
import { FavouritesController } from "./favourites.controller"
import { FavouritesRepository } from "./favourites.repository"
import { FavouritesService } from "./favourites.service"

@Module({
	controllers: [FavouritesController],
	providers: [FavouritesRepository, FavouritesService],
	exports: [FavouritesService],
})
export class FavouritesModule {}
