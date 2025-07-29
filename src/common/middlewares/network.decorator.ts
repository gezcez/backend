import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiParam} from '@nestjs/swagger';
import { NetworkGuard } from './network.guard'; 

export function UseNetwork() {
  return applyDecorators(
    UseGuards(NetworkGuard),
    ApiParam({ name: 'network_id', required: true, type: String }),
  );
}