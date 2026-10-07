import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * Dokumentasi Swagger untuk endpoint paginasi berbentuk { data: T[], meta }.
 *
 * @example
 *   @ApiPaginated(CustomerDto)
 *   @Get()
 */
export function ApiPaginated<TModel extends Type<unknown>>(
  model: TModel,
  description = 'Daftar data',
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { $ref: getSchemaPath(model) },
          },
          meta: {
            type: 'object',
            properties: {
              total: { type: 'number', example: 125 },
              page: { type: 'number', example: 1 },
              limit: { type: 'number', example: 20 },
              totalPages: { type: 'number', example: 7 },
            },
          },
        },
      },
    }),
  );
}
