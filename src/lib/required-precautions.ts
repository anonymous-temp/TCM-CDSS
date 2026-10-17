/**
 * 本例注意事项里必须写到的内容（2026-10-17，甲方标准病历 3、7 与留出例 S143 的独立评审）。
 *
 * 提示词一直要求模型写已自服药物的重叠、产后哺乳与丹毒的抗感染，模型多数时候写、有时漏（病历 7 三次全漏自服的
 * 黄连上清丸与甲硝唑；病历 3 三次里一次漏哺乳；S143 丹毒没写抗菌治疗）。联网查到的做法一致：要写的项目由规则算出，
 * 逐项告诉模型，生成后逐项核对，漏了用规则自己的那句补上（漏项靠模型自查查不出来；处方系统里的重复用药提示历来是规则做的）。
 *
 * 这里只有类型；由病历算出项目在 required-precautions.server.ts，核对与补写在 delivered-surface.ts（交付面，签名之前）。
 */
export type RequiredPrecaution =
  | {
      kind: "self_medication";
      /** 病历原文里的药名（「黄连上清丸」「甲硝唑片」）。 */
      name: string;
      /** 去剂型的名字，用来判断注意事项里是否已经提到（「黄连上清」「甲硝唑」）。 */
      base: string;
      /** 中成药在方剂目录里各版本共有的药味（组成身份名）；西药或查不到组成时为空。 */
      composition: string[];
      /** 本地说明书目录里有说明书写明该药与酒同用会引起双硫仑样反应或须戒酒。 */
      alcoholWarning: boolean;
    }
  | { kind: "postpartum_lactation" }
  | { kind: "skin_infection_antibiotic"; disease: string };
