import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorPayload {
  message?: unknown;
  error?: string;
}

/**
 * Format error seragam untuk seluruh API:
 * { statusCode, message, error, path, timestamp }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = isHttp ? exception.getResponse() : 'Terjadi kesalahan pada server';

    let message: unknown;
    let errorName: string;
    if (typeof raw === 'string') {
      message = raw;
      errorName = isHttp ? exception.constructor.name : 'InternalServerError';
    } else {
      const payload = raw as ErrorPayload;
      message = payload.message ?? raw;
      errorName = payload.error ?? (isHttp ? exception.constructor.name : 'InternalServerError');
    }

    response.status(status).json({
      statusCode: status,
      message,
      error: errorName,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
