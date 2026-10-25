import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  CreateEmployeeRequest,
  DIRECTORY_PATHS,
  EmployeeDto,
  EmployeeParams,
  EmployeesParams,
  ListEmployeesQuery,
  ListEmployeesResponse,
  UpdateEmployeeRequest,
} from '@meetops/contracts';
import type { DirectoryAccess } from '../../directory/access.js';
import {
  directoryErrors,
  directoryWriteErrors,
  type ResolveCaller,
} from '../../directory/http/route-kit.js';
import type { EmployeeService } from '../application/employee.service.js';
import { toEmployeeDto } from './mappers.js';

export interface EmployeeRoutesOptions {
  employees: EmployeeService;
  access: DirectoryAccess;
  caller: ResolveCaller;
}

const tags = ['employees'];

export async function employeeRoutes(app: FastifyInstance, opts: EmployeeRoutesOptions) {
  const { employees, access, caller } = opts;

  app.get<{ Params: EmployeesParams; Querystring: ListEmployeesQuery }>(
    DIRECTORY_PATHS.employees,
    {
      schema: {
        tags,
        summary: 'List employees',
        description:
          'Cursor page of the organization’s employees. `email` is returned to owners and admins only.',
        params: EmployeesParams,
        querystring: ListEmployeesQuery,
        response: { 200: ListEmployeesResponse, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const { cursor, limit, q } = request.query;
      const page = await employees.list(c, { cursor, limit: limit ?? 25, q });
      const withEmail = access.canSeeContactDetails(c);
      return {
        items: page.items.map((e) => toEmployeeDto(e, { withEmail })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post<{ Params: EmployeesParams; Body: CreateEmployeeRequest }>(
    DIRECTORY_PATHS.employees,
    {
      schema: {
        tags,
        summary: 'Create employee',
        description:
          'Owner/admin. 409 CONFLICT for a duplicate email or linked user; 404 when `userId` is not an org member.',
        params: EmployeesParams,
        body: CreateEmployeeRequest,
        response: { 201: EmployeeDto, ...directoryWriteErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      const e = await employees.create(c, request.body);
      return reply.code(201).send(toEmployeeDto(e, { withEmail: true }));
    },
  );

  app.get<{ Params: EmployeeParams }>(
    DIRECTORY_PATHS.employee,
    {
      schema: {
        tags,
        summary: 'Get employee',
        params: EmployeeParams,
        response: { 200: EmployeeDto, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const e = await employees.get(c, request.params.employeeId);
      return toEmployeeDto(e, { withEmail: access.canSeeContactDetails(c) });
    },
  );

  app.patch<{ Params: EmployeeParams; Body: UpdateEmployeeRequest }>(
    DIRECTORY_PATHS.employee,
    {
      schema: {
        tags,
        summary: 'Update employee',
        description: 'Owner/admin. Partial update; `null` clears a field.',
        params: EmployeeParams,
        body: UpdateEmployeeRequest,
        response: { 200: EmployeeDto, ...directoryWriteErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const e = await employees.update(c, request.params.employeeId, request.body);
      return toEmployeeDto(e, { withEmail: true });
    },
  );

  app.delete<{ Params: EmployeeParams }>(
    DIRECTORY_PATHS.employee,
    {
      schema: {
        tags,
        summary: 'Delete employee',
        description: 'Owner/admin. Soft delete; also removes the employee from every team.',
        params: EmployeeParams,
        response: { 204: Type.Null(), ...directoryErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      await employees.remove(c, request.params.employeeId);
      return reply.code(204).send();
    },
  );
}
