-- Troca o modelo do IIU pelas 7 dimensoes da matriz da tese (ECO, PES, GOV, MOB, AMB, QVI, IDD).
-- Seguro para reaplicar. O modelo anterior (7 dimensoes, pesos e configuracao dos 42 indicadores) fica
-- guardado em core.iiu_legacy_snapshot antes de qualquer alteracao.
-- Faixas de referencia (benchmarks) NAO sao criadas aqui: sem faixa o painel mostra o valor observado e deixa a
-- pontuacao em branco; defina as faixas em /iiu/configuracao.

create table if not exists core.iiu_legacy_snapshot (
  id integer generated always as identity primary key,
  taken_at timestamptz not null default now(),
  payload jsonb not null
);
alter table core.iiu_legacy_snapshot enable row level security;
grant select on core.iiu_legacy_snapshot to service_role;

insert into core.iiu_legacy_snapshot (payload)
select jsonb_build_object(
  'dimensions', (select coalesce(jsonb_agg(to_jsonb(dimensions) order by dimensions.display_order), '[]'::jsonb) from core.iiu_dimensions dimensions),
  'weights', (select coalesce(jsonb_agg(to_jsonb(weights)), '[]'::jsonb) from core.iiu_dimension_weights weights),
  'indicators', (select coalesce(jsonb_agg(jsonb_build_object('code', indicators.code, 'iiu_enabled', indicators.iiu_enabled, 'iiu_dimension_code', indicators.iiu_dimension_code, 'iiu_type', indicators.iiu_type, 'score_direction', indicators.score_direction, 'checklist_max', indicators.checklist_max)), '[]'::jsonb) from municipal.indicators indicators where indicators.iiu_dimension_code is not null),
  'benchmarks', (select coalesce(jsonb_agg(jsonb_build_object('indicator_code', indicators.code, 'city_profile', benchmarks.city_profile, 'minimum_value', benchmarks.minimum_value, 'maximum_value', benchmarks.maximum_value)), '[]'::jsonb) from core.iiu_indicator_benchmarks benchmarks join municipal.indicators indicators on indicators.id = benchmarks.indicator_id)
)
where not exists (select 1 from core.iiu_legacy_snapshot);

-- Indicadores do modelo antigo saem do calculo.
update municipal.indicators
set iiu_enabled = false, iiu_dimension_code = null, score_direction = null, checklist_max = null
where iiu_dimension_code is not null and code !~ '^(eco|pes|gov|mob|amb|qvi|idd)[0-9]{2}_';

delete from core.iiu_dimension_weights where dimension_code in ('ene', 'sau', 'seg', 'hab');
delete from core.iiu_dimensions where code in ('ene', 'sau', 'seg', 'hab');

-- display_order e unico: afasta as linhas existentes antes de reordenar.
update core.iiu_dimensions set display_order = display_order + 100 where display_order <= 100;

insert into core.iiu_dimensions (code, name, color, display_order) values
  ('eco', 'Economia', '#f59e0b', 1),
  ('pes', 'Pessoas', '#ec4899', 2),
  ('gov', 'Governança', '#8b5cf6', 3),
  ('mob', 'Mobilidade', '#3b82f6', 4),
  ('amb', 'Ambiente', '#10b981', 5),
  ('qvi', 'Qualidade de Vida', '#f97316', 6),
  ('idd', 'Infraestrutura Digital e Dados', '#06b6d4', 7)
on conflict (code) do update set name = excluded.name, color = excluded.color, display_order = excluded.display_order;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight)
select profiles.profile, defaults.code, defaults.weight
from unnest(enum_range(null::core.iiu_city_profile)) as profiles(profile)
cross join (values
  ('eco', 14.28),
  ('pes', 14.28),
  ('gov', 14.28),
  ('mob', 14.28),
  ('amb', 14.29),
  ('qvi', 14.29),
  ('idd', 14.30)
) as defaults(code, weight)
on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

update municipal.indicators as indicators
set iiu_enabled = true, iiu_dimension_code = thesis.dimension_code, iiu_type = thesis.iiu_type, score_direction = thesis.direction::core.iiu_score_direction, checklist_max = thesis.checklist_max::numeric
from (values
  ('eco01_pib_municipal_per_capita', 'eco', 'Produtividade', 'direct', null),
  ('eco02_participacao_do_vab_industrial_e_de_servicos', 'eco', 'Estrutura econômica', 'direct', null),
  ('eco03_densidade_de_empregos_formais', 'eco', 'Mercado de trabalho', 'direct', null),
  ('eco04_remuneracao_media_do_emprego_formal', 'eco', 'Renda do trabalho', 'direct', null),
  ('eco05_saldo_de_empregos_formais', 'eco', 'Dinamismo do emprego', 'direct', null),
  ('eco06_densidade_de_estabelecimentos_formais', 'eco', 'Empreendedorismo', 'direct', null),
  ('eco07_facilidade_para_abertura_de_empresas', 'eco', 'Ambiente de negócios', 'inverse', null),
  ('eco08_emprego_em_setores_intensivos_em_conhecimento', 'eco', 'Inovação e conhecimento', 'direct', null),
  ('eco09_exportacoes_municipais_per_capita', 'eco', 'Inserção externa', 'direct', null),
  ('eco10_depositos_de_patentes_por_100_mil_habitantes', 'eco', 'Capacidade inovadora', 'direct', null),
  ('pes01_taxa_de_alfabetizacao_da_populacao_de_14_anos_ou', 'pes', 'Qualificação', 'direct', null),
  ('pes02_populacao_de_25_anos_ou_mais_com_ensino_superior', 'pes', 'Qualificação', 'direct', null),
  ('pes03_taxa_de_frequencia_escolar_de_6_a_17_anos', 'pes', 'Acesso à educação', 'direct', null),
  ('pes04_cobertura_de_creche_para_criancas_de_0_a_3_anos', 'pes', 'Primeira infância', 'direct', null),
  ('pes05_ideb_anos_iniciais_do_ensino_fundamental', 'pes', 'Qualidade da educação', 'direct', null),
  ('pes06_ideb_anos_finais_do_ensino_fundamental', 'pes', 'Qualidade da educação', 'direct', null),
  ('pes07_taxa_de_distorcao_idade_serie', 'pes', 'Equidade educacional', 'inverse', null),
  ('pes08_taxa_de_aprovacao_escolar', 'pes', 'Fluxo escolar', 'direct', null),
  ('pes09_matriculas_em_eja_por_mil_adultos_sem_educacao_b', 'pes', 'Aprendizagem ao longo da vida', 'direct', null),
  ('gov01_indice_de_transparencia_ativa', 'gov', 'Transparência', 'direct', null),
  ('gov02_maturidade_do_portal_de_dados_abertos', 'gov', 'Maturidade portal de dados', 'checklist', 5),
  ('gov03_capacidade_tecnica_da_administracao_municipal_pa', 'gov', 'Quadro técnico qualificado', 'direct', null),
  ('gov04_taxa_de_comparecimento_eleitoral', 'gov', 'Participação política', 'direct', null),
  ('gov05_conselhos_municipais_ativos', 'gov', 'Participação institucional', 'direct', null),
  ('gov06_mecanismos_participativos_no_planejamento_e_orca', 'gov', 'Participação cidadã', 'checklist', 5),
  ('gov07_participacao_das_receitas_proprias', 'gov', 'Autonomia fiscal', 'direct', null),
  ('gov08_despesa_de_capital_municipal_per_capita', 'gov', 'Capacidade de investimento', 'direct', null),
  ('gov09_despesa_com_pessoal_sobre_receita_corrente', 'gov', 'Sustentabilidade fiscal', 'inverse', null),
  ('gov10_indice_de_instrumentos_de_planejamento_vigentes', 'gov', 'Planejamento urbano', 'direct', null),
  ('gov11_disponibilidade_e_desempenho_de_ouvidoria_e_sic', 'gov', 'Responsividade', 'direct', null),
  ('gov12_participacao_em_consorcios_publicos', 'gov', 'Cooperação intermunicipal', 'direct', null),
  ('mob01_proporcao_de_trabalhadores_com_deslocamento_supe', 'mob', 'Acessibilidade temporal', 'inverse', null),
  ('mob02_participacao_dos_modos_sustentaveis_nos_deslocam', 'mob', 'Mobilidade sustentável', 'direct', null),
  ('mob03_taxa_de_motorizacao', 'mob', 'Motorização', 'inverse', null),
  ('mob04_participacao_de_veiculos_de_baixa_emissao', 'mob', 'Transição energética', 'direct', null),
  ('mob05_mortalidade_no_transito', 'mob', 'Segurança viária', 'inverse', null),
  ('mob06_populacao_a_ate_500_m_de_ponto_estacao', 'mob', 'Cobertura do transporte público', 'direct', null),
  ('mob07_oferta_programada_de_transporte_coletivo', 'mob', 'Oferta de transporte público', 'direct', null),
  ('mob08_extensao_da_infraestrutura_cicloviaria', 'mob', 'Mobilidade ativa', 'direct', null),
  ('mob09_acessibilidade_da_frota_e_dos_pontos', 'mob', 'Acessibilidade universal', 'direct', null),
  ('mob10_maturidade_digital_do_transporte_coletivo', 'mob', 'Digitalização do transporte', 'checklist', 5),
  ('mob11_existencia_e_implementacao_do_planmob', 'mob', 'Plano de mobilidade urbana', 'checklist', 2),
  ('amb01_cobertura_do_abastecimento_de_agua', 'amb', 'Abastecimento de água', 'direct', null),
  ('amb02_cobertura_da_coleta_de_esgoto', 'amb', 'Esgotamento sanitário', 'direct', null),
  ('amb03_tratamento_do_esgoto_coletado', 'amb', 'Esgotamento sanitário', 'direct', null),
  ('amb04_indice_de_perdas_na_distribuicao', 'amb', 'Eficiência hídrica', 'inverse', null),
  ('amb05_cobertura_da_coleta_domiciliar', 'amb', 'Resíduos sólidos', 'direct', null),
  ('amb06_cobertura_da_coleta_seletiva', 'amb', 'Economia circular', 'direct', null),
  ('amb07_residuos_destinados_adequadamente', 'amb', 'Destinação de resíduos', 'direct', null),
  ('amb08_proporcao_de_vegetacao_no_territorio_municipal', 'amb', 'Cobertura vegetal', 'direct', null),
  ('amb09_area_verde_urbana_per_capita', 'amb', 'Áreas verdes urbanas', 'direct', null),
  ('amb10_emissoes_liquidas_de_gee_per_capita', 'amb', 'Mudança climática', 'inverse', null),
  ('amb11_potencia_de_micro_e_minigeracao_distribuida', 'amb', 'Energia renovável', 'direct', null),
  ('amb13_ocorrencias_e_perdas_por_desastres', 'amb', 'Resiliência a desastres', 'inverse', null),
  ('amb14_indice_municipal_de_risco_climatico', 'amb', 'Risco climático', 'inverse', null),
  ('amb15_concentracao_anual_de_pm2_5_ou_dias_fora_do_padr', 'amb', 'Qualidade do ar', 'inverse', null),
  ('amb16_consumo_municipal_de_energia_eletrica_per_capita', 'amb', 'Consumo energético', 'inverse', null),
  ('amb17_domicilios_com_acesso_a_energia_eletrica', 'amb', 'Acesso à energia', 'direct', null),
  ('amb18_potencia_centralizada_instalada_no_municipio', 'amb', 'Oferta de energia', 'direct', null),
  ('amb19_participacao_renovavel_na_potencia_instalada', 'amb', 'Matriz energética', 'direct', null),
  ('amb20_duracao_equivalente_de_interrupcao_dec_municipal', 'amb', 'Confiabilidade elétrica', 'inverse', null),
  ('amb21_frequencia_equivalente_de_interrupcao_fec_munici', 'amb', 'Confiabilidade elétrica', 'inverse', null),
  ('amb22_cobertura_da_tarifa_social_de_energia_eletrica', 'amb', 'Vulnerabilidade energética', 'direct', null),
  ('amb23_cobertura_de_iluminacao_publica_no_entorno_dos_d', 'amb', 'Iluminação pública', 'direct', null),
  ('amb24_participacao_de_luminarias_publicas_com_tecnolog', 'amb', 'Eficiência da iluminação', 'direct', null),
  ('amb25_economia_anual_dos_projetos_de_eficiencia_energe', 'amb', 'Eficiência energética', 'direct', null),
  ('qvi01_taxa_de_mortalidade_infantil', 'qvi', 'Saúde materno-infantil', 'inverse', null),
  ('qvi02_cobertura_da_atencao_primaria_esf', 'qvi', 'Atenção primária', 'direct', null),
  ('qvi03_leitos_hospitalares_por_mil_habitantes', 'qvi', 'Capacidade hospitalar', 'direct', null),
  ('qvi04_medicos_por_mil_habitantes', 'qvi', 'Recursos humanos em saúde', 'direct', null),
  ('qvi05_internacoes_por_condicoes_sensiveis_a_atencao_pr', 'qvi', 'Efetividade da atenção básica', 'inverse', null),
  ('qvi06_mortalidade_prematura_por_dcnt', 'qvi', 'Saúde da população', 'inverse', null),
  ('qvi07_cobertura_vacinal', 'qvi', 'Vacinação', 'direct', null),
  ('qvi08_taxa_de_homicidios', 'qvi', 'Segurança', 'inverse', null),
  ('qvi09_indice_de_desenvolvimento_humano_municipal', 'qvi', 'IDH-M', 'direct', null),
  ('qvi10_domicilios_com_inadequacao_habitacional', 'qvi', 'Habitação adequada', 'inverse', null),
  ('qvi11_populacao_em_favelas_e_comunidades_urbanas', 'qvi', 'Precariedade urbana', 'inverse', null),
  ('qvi12_populacao_familias_de_baixa_renda_no_cadastro_un', 'qvi', 'Coesão social', 'inverse', null),
  ('qvi13_equipamentos_culturais_por_100_mil_habitantes', 'qvi', 'Cultura', 'direct', null),
  ('qvi14_equipamentos_publicos_de_esporte_e_lazer_por_100', 'qvi', 'Esporte e lazer', 'direct', null),
  ('qvi15_leitos_de_hospedagem_ou_estabelecimentos_turisti', 'qvi', 'Atratividade turística', 'direct', null),
  ('qvi16_deficit_habitacional_municipal_estimado', 'qvi', 'Necessidade habitacional', 'inverse', null),
  ('qvi17_taxa_de_domicilios_vagos', 'qvi', 'Ocupação do estoque', 'inverse', null),
  ('qvi18_domicilios_proprios_ocupados', 'qvi', 'Segurança da posse', 'direct', null),
  ('qvi19_onus_excessivo_com_aluguel_urbano', 'qvi', 'Acessibilidade econômica', 'inverse', null),
  ('qvi20_adensamento_excessivo_em_domicilios_alugados', 'qvi', 'Adensamento domiciliar', 'inverse', null),
  ('qvi21_domicilios_improvisados_ou_rusticos', 'qvi', 'Precariedade construtiva', 'inverse', null),
  ('qvi22_domicilios_ou_populacao_em_areas_de_alto_e_muito', 'qvi', 'Risco habitacional', 'inverse', null),
  ('qvi23_unidades_habitacionais_do_mcmv_contratadas_ou_co', 'qvi', 'Provisão habitacional', 'direct', null),
  ('qvi24_regularidade_municipal_no_snhis', 'qvi', 'Capacidade da política habitacional', 'checklist', 4),
  ('idd01_acessos_de_banda_larga_fixa_por_100_domicilios', 'idd', 'Conectividade fixa', 'direct', null),
  ('idd02_participacao_de_acessos_em_fibra_optica', 'idd', 'Qualidade da conectividade', 'direct', null),
  ('idd03_cobertura_populacional_4g_ou_5g', 'idd', 'Cobertura móvel', 'direct', null),
  ('idd04_estacoes_radio_base_por_100_mil_habitantes', 'idd', 'Infraestrutura de telecomunicações', 'direct', null),
  ('idd05_infraestrutura_de_sensores_inteligentes_instalad', 'idd', 'Sensoriamento urbano', 'checklist', 4),
  ('idd06_pontos_publicos_de_wi_fi_por_100_mil_habitantes', 'idd', 'Inclusão digital', 'direct', null),
  ('idd07_servicos_municipais_totalmente_digitais', 'idd', 'Governo digital', 'direct', null),
  ('idd08_maturidade_do_portal_de_dados_abertos', 'idd', 'Dados abertos', 'checklist', 8),
  ('idd09_integracao_da_plataforma_urbana_de_dados', 'idd', 'Interoperabilidade', 'direct', null),
  ('idd10_maturidade_de_seguranca_da_informacao_e_lgpd', 'idd', 'Cibersegurança e privacidade', 'checklist', 8),
  ('idd11_escolas_com_internet_adequada', 'idd', 'Conectividade educacional', 'direct', null),
  ('idd12_estabelecimentos_de_saude_com_conectividade_sist', 'idd', 'Saúde digital', 'direct', null)
) as thesis(code, dimension_code, iiu_type, direction, checklist_max)
where indicators.code = thesis.code and indicators.active;
