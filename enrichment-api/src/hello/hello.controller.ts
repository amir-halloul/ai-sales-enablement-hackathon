import { Controller, Get } from '@nestjs/common';

export interface HelloResponse {
  message: string;
}

@Controller('hello')
export class HelloController {
  @Get()
  hello(): HelloResponse {
    return { message: 'Hello from enrichment-api' };
  }
}
