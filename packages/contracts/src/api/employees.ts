import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime, SafeDisplayText } from '../common.js';
import {
  MAX_DIRECTORY_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_EMPLOYEE_FIELD_LENGTH,
} from '../constants.js';
import { CursorPage, CursorPageQuery } from './pagination.js';

const strict = { additionalProperties: false } as const;

/** Employee full name: SafeDisplayText (no control, HTML-significant or bidi/format characters), 1-200, trimmed. */
export const EmployeeName = SafeDisplayText({
  maxLength: MAX_DIRECTORY_NAME_LENGTH,
  trimmed: true,
});
/** Employee title, department or externalId: SafeDisplayText, 1-200, trimmed. */
export const EmployeeField = SafeDisplayText({
  maxLength: MAX_EMPLOYEE_FIELD_LENGTH,
  trimmed: true,
});
/** Employee email (not necessarily a MeetOps account): format `email`, at most 254 characters. */
export const EmployeeEmail = Type.String({ format: 'email', maxLength: MAX_EMAIL_LENGTH });

/**
 * v0.4.0: an employee in the organization directory (Prisma `Employee`, table `employees`). Soft-deleted employees are
 * never returned. `userId` links the employee to a MeetOps user who is a member of the organization, or is null.
 *
 * **Email visibility (RBAC):** like UserSummary, `email` is optional. The API MUST include it only when the viewer's
 * role in the org is `owner` or `admin`, and MUST omit it for `member` and `viewer` viewers.
 */
export const EmployeeDto = Type.Object(
  {
    id: Id,
    organizationId: Id,
    userId: Type.Union([Id, Type.Null()]),
    fullName: EmployeeName,
    email: Type.Optional(Type.Union([EmployeeEmail, Type.Null()])),
    title: Type.Union([EmployeeField, Type.Null()]),
    department: Type.Union([EmployeeField, Type.Null()]),
    externalId: Type.Union([EmployeeField, Type.Null()]),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  strict,
);
export type EmployeeDto = Static<typeof EmployeeDto>;

/** Path params of the employees collection routes (`DIRECTORY_PATHS.employees`). */
export const EmployeesParams = Type.Object({ organizationId: Id }, strict);
export type EmployeesParams = Static<typeof EmployeesParams>;
/** Path params of the single-employee routes (`DIRECTORY_PATHS.employee`). */
export const EmployeeParams = Type.Object({ organizationId: Id, employeeId: Id }, strict);
export type EmployeeParams = Static<typeof EmployeeParams>;

/**
 * POST /orgs/:organizationId/employees (201 EmployeeDto). Clients MUST trim text fields. `userId`, when given, must be
 * a member of the organization; otherwise the API returns NOT_FOUND (same body as an unknown id).
 */
export const CreateEmployeeRequest = Type.Object(
  {
    fullName: EmployeeName,
    email: Type.Optional(EmployeeEmail),
    title: Type.Optional(EmployeeField),
    department: Type.Optional(EmployeeField),
    externalId: Type.Optional(EmployeeField),
    userId: Type.Optional(Id),
  },
  strict,
);
export type CreateEmployeeRequest = Static<typeof CreateEmployeeRequest>;

/** PATCH /orgs/:organizationId/employees/:employeeId (200 EmployeeDto). At least one field; `null` clears a field. */
export const UpdateEmployeeRequest = Type.Object(
  {
    fullName: Type.Optional(EmployeeName),
    email: Type.Optional(Type.Union([EmployeeEmail, Type.Null()])),
    title: Type.Optional(Type.Union([EmployeeField, Type.Null()])),
    department: Type.Optional(Type.Union([EmployeeField, Type.Null()])),
    externalId: Type.Optional(Type.Union([EmployeeField, Type.Null()])),
    userId: Type.Optional(Type.Union([Id, Type.Null()])),
  },
  { ...strict, minProperties: 1 },
);
export type UpdateEmployeeRequest = Static<typeof UpdateEmployeeRequest>;

/** GET /orgs/:organizationId/employees query: cursor page plus an optional name/email search `q`. */
export const ListEmployeesQuery = Type.Object(
  {
    ...CursorPageQuery.properties,
    q: Type.Optional(SafeDisplayText({ maxLength: MAX_DIRECTORY_NAME_LENGTH })),
  },
  strict,
);
export type ListEmployeesQuery = Static<typeof ListEmployeesQuery>;

/** GET /orgs/:organizationId/employees: cursor page of EmployeeDto (`nextCursor` null on the last page). */
export const ListEmployeesResponse = Type.Object(CursorPage(EmployeeDto).properties, strict);
export type ListEmployeesResponse = Static<typeof ListEmployeesResponse>;
