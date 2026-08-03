import { z } from "zod";
import { CompanyTemplateSchema, TeamTemplateSchema, AgentCardSchema, PromptTemplateSchema } from "@opc/shared";
import type { CompanyTemplate, TeamTemplate, AgentCard, PromptTemplate } from "@opc/shared";

declare const ct: z.infer<typeof CompanyTemplateSchema>;
const a: CompanyTemplate = ct;

declare const tt: z.infer<typeof TeamTemplateSchema>;
const b: TeamTemplate = tt;

declare const ac: z.infer<typeof AgentCardSchema>;
const c: AgentCard = ac;

declare const pt: z.infer<typeof PromptTemplateSchema>;
const d: PromptTemplate = pt;

// P2(审计)· CompanyTemplateSchema 现为 .passthrough()(保留未知顶层键,前向兼容),其 z.infer 因此带
// { [k: string]: unknown } 索引签名。CompanyTemplate 手写类型不含索引签名,这是**有意**的差异(schema 是
// 已知字段的超集)。用 & Record<string, unknown> 承认这层索引签名,同时保留"已知字段类型必须一致"的漂移检查
// (若某已知字段的 TS 类型与 schema 不符,此赋值仍会报错)。
declare const ci: CompanyTemplate & Record<string, unknown>;
const e: z.infer<typeof CompanyTemplateSchema> = ci;

void a; void b; void c; void d; void e;
