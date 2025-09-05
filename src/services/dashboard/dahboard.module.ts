import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardUtilitiesController } from './utils.controller';

@Module({
  controllers: [
    DashboardController,
    DashboardUtilitiesController,
  ],
})
export class DashboardModule {}