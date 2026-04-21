-- MERT-M initial seed: suppliers, products, inventory, partners
-- Safe to re-run: uses ON CONFLICT DO NOTHING where unique keys exist.

BEGIN;

-- ============================================================
-- SUPPLIERS (brands / distributors MERT-M buys from)
-- ============================================================
INSERT INTO suppliers (name, eik, vat_number, city, address, contact_person, phone, email, bank_name, iban)
VALUES
  ('Hendi Bulgaria EOOD',        '201234567', 'BG201234567', 'София',  'бул. Цариградско шосе 115, София',     'Ivan Petrov',    '02 9876543',  'sales@hendi.bg',        'UniCredit Bulbank',   'BG80UNCR70001522000001'),
  ('Bartscher Distribution EOOD','202345678', 'BG202345678', 'София',  'ул. Индустриална 7, София',             'Georgi Ivanov',  '02 9865432',  'office@bartscher.bg',   'DSK Bank',            'BG80STSA93000012345601'),
  ('Unox Bulgaria EOOD',         '203456789', 'BG203456789', 'Пловдив','бул. Санкт Петербург 45, Пловдив',      'Stefan Kostov',  '032 876543',  'info@unox.bg',          'UniCredit Bulbank',   'BG80UNCR70001522000002'),
  ('KitchenAid BG EOOD',         '204567890', 'BG204567890', 'София',  'бул. Симеоновско шосе 120, София',      'Daniela Dimova', '02 8765432',  'sales@kitchenaid.bg',   'Postbank',            'BG80BPBI79401012345601'),
  ('Liebherr Bulgaria EOOD',     '205678901', 'BG205678901', 'София',  'бул. България 102, София',              'Petar Nikolov',  '02 7654321',  'office@liebherr.bg',    'UniCredit Bulbank',   'BG80UNCR70001522000003'),
  ('Fiamma Import EOOD',         '206789012', 'BG206789012', 'Варна',  'бул. Княз Борис I 88, Варна',           'Maria Georgieva','052 987654',  'sales@fiamma.bg',       'DSK Bank',            'BG80STSA93000012345602')
ON CONFLICT DO NOTHING;


-- ============================================================
-- PRODUCTS (kitchen equipment across 15 categories)
-- ============================================================
INSERT INTO products (sku, name_bg, name_en, category_id, brand, unit, purchase_price, selling_price, low_stock_threshold, description)
VALUES
  -- 1. Скари и плочи
  ('HEN-203174', 'Контактна скара Hendi 400×400, единична', 'Hendi Contact Grill 400×400 single',    1, 'Hendi',    'бр.',   580.00,   890.00, 3, 'Гладка скара 400×400 мм, мощност 2.5kW, темп. до 300°C'),
  ('HEN-203181', 'Контактна скара Hendi 400×400, двойна',   'Hendi Contact Grill 400×400 double',    1, 'Hendi',    'бр.',   980.00,  1490.00, 2, 'Гладка/рифелна скара 400×400 мм'),
  ('BAR-160750', 'Електрическа плоча Bartscher G450',       'Bartscher Electric Griddle G450',       1, 'Bartscher','бр.',  1150.00,  1790.00, 2, 'Хромирана повърхност, 3kW'),
  ('UNO-XEVC',   'Унос скара чугунена 600×400',             'Unox cast iron griddle 600×400',        1, 'Unox',     'бр.',   760.00,  1150.00, 2, 'Чугунена скара за газова печка'),

  -- 2. Фритюрници
  ('HEN-207895', 'Фритюрник Hendi 8L единичен',             'Hendi Fryer 8L single',                 2, 'Hendi',    'бр.',   340.00,   520.00, 4, 'Обем 8L, мощност 3.25kW'),
  ('HEN-207901', 'Фритюрник Hendi 2x8L двоен',              'Hendi Fryer 2x8L double',               2, 'Hendi',    'бр.',   620.00,   940.00, 3, 'Двоен 8+8 литра'),
  ('BAR-162320', 'Фритюрник Bartscher Snack III Plus',      'Bartscher Snack III Plus Fryer',        2, 'Bartscher','бр.',   490.00,   760.00, 3, '2x8L, термостат'),
  ('BAR-162760', 'Фритюрник газов Bartscher 20L',           'Bartscher Gas Fryer 20L',               2, 'Bartscher','бр.',  1450.00,  2190.00, 1, 'Газов, 20L, професионален'),

  -- 3. Бен Мари и топли витрини
  ('HEN-226018', 'Бен Мари Hendi 3xGN1/1',                  'Hendi Bain-Marie 3xGN1/1',              3, 'Hendi',    'бр.',   520.00,   790.00, 3, 'Три гастронорма с капак'),
  ('BAR-300334', 'Топла витрина Bartscher 3GN1/1 стъклена', 'Bartscher Hot Display 3GN1/1 glass',    3, 'Bartscher','бр.',  1280.00,  1940.00, 2, 'Стъклена витрина 3 нива'),
  ('HEN-268201', 'Супница Hendi 10L с кранче',              'Hendi Soup kettle 10L with tap',        3, 'Hendi',    'бр.',   320.00,   490.00, 4, 'Бойлер за супа 10L'),

  -- 4. Супници и казани
  ('UNO-KSM500', 'Казан 50L електрически пароводен',        'Electric steam kettle 50L',             4, 'Unox',     'бр.',  3200.00,  4890.00, 1, 'Професионален 50L'),
  ('BAR-164055', 'Супница Bartscher 6L',                    'Bartscher Soup kettle 6L',              4, 'Bartscher','бр.',   240.00,   380.00, 5, 'Компактна 6L'),

  -- 5. Печки и фурни
  ('UNO-XB693',  'Конвектомат Unox XB693 Bakerlux',         'Unox XB693 Bakerlux convection oven',   5, 'Unox',     'бр.',  2980.00,  4490.00, 2, '6x EN 600×400, парна инжекция'),
  ('UNO-XEVC0511','Конвектомат Unox ChefTop 5xGN1/1',       'Unox ChefTop 5xGN1/1 combi oven',       5, 'Unox',     'бр.',  5800.00,  8790.00, 1, '5xGN1/1 електрически, MIND.Maps Plus'),
  ('HEN-226933', 'Електрическа печка Hendi 4 котлона',      'Hendi Electric stove 4-burner',         5, 'Hendi',    'бр.',   890.00,  1340.00, 2, '4 котлона, работна повърхност'),
  ('BAR-286200', 'Газова печка Bartscher 600 4 котлона',    'Bartscher Gas stove 600 4-burner',      5, 'Bartscher','бр.',  1580.00,  2390.00, 1, 'Газова, модул 600, с фурна'),

  -- 6. Пицари
  ('UNO-PIZZA1', 'Унос пица пещ 4x30см XB430',              'Unox Pizza oven 4x30cm XB430',          6, 'Unox',     'бр.',  2490.00,  3790.00, 2, 'Електрическа пицарна, до 450°C'),
  ('BAR-203100', 'Пица пещ Bartscher ET 105 1x45 камък',    'Bartscher Pizza oven ET 105',           6, 'Bartscher','бр.',   980.00,  1490.00, 2, 'Единична камера, камък 45см'),

  -- 7. Миялни машини
  ('HOB-L40',    'Куполна миялна машина Hobart 50x50',      'Hobart hood dishwasher 50x50',          7, 'Hobart',   'бр.',  4500.00,  6790.00, 1, 'Куполна, 60 коша/час'),
  ('WIN-UC65',   'Чашомиялна Winterhalter UC-M',            'Winterhalter UC-M glasswasher',         7, 'Winterhalter','бр.',2890.00,  4390.00, 1, 'За чаши и чинии до 400×400'),
  ('BAR-110306', 'Миялна Bartscher GS-E400 LPR',            'Bartscher GS-E400 LPR dishwasher',      7, 'Bartscher','бр.',  1680.00,  2490.00, 2, 'Подплотова, 400×400 кош'),

  -- 8. Хладилници и фризери
  ('LIE-GKV6460','Хладилник Liebherr GKv 6460 600L',        'Liebherr GKv 6460 fridge 600L',         8, 'Liebherr', 'бр.',  1950.00,  2940.00, 2, 'Професионален хладилник 600L'),
  ('LIE-GGV5060','Фризер Liebherr GGv 5060 500L',           'Liebherr GGv 5060 freezer 500L',        8, 'Liebherr', 'бр.',  2180.00,  3290.00, 2, 'Фризер 500L, до -28°C'),
  ('LIE-TPS1760','Подплотов хладилник Liebherr TPS 1760',   'Liebherr TPS 1760 undercounter',        8, 'Liebherr', 'бр.',   980.00,  1490.00, 3, 'Подплотов 130L'),
  ('HEN-233122', 'Салатник Hendi 2 врати GN1/1',            'Hendi Salad prep fridge 2-door',        8, 'Hendi',    'бр.',  1380.00,  2090.00, 2, 'Салатник с 2 врати, GN1/1'),

  -- 9. Миксери и блендери
  ('KAD-5KSM150','Миксер KitchenAid Artisan 4.8L',          'KitchenAid Artisan mixer 4.8L',         9, 'KitchenAid','бр.',  720.00,  1090.00, 3, 'Класически миксер 4.8L, 10 скорости'),
  ('KAD-5KSM70', 'Миксер KitchenAid Professional 6.9L',     'KitchenAid Professional 6.9L',          9, 'KitchenAid','бр.', 1290.00,  1940.00, 2, 'Професионален 6.9L, 11 скорости'),
  ('HEN-221099', 'Ръчен блендер Hendi 400W',                'Hendi hand blender 400W',               9, 'Hendi',    'бр.',   180.00,   280.00, 6, 'Ръчен професионален'),
  ('BAR-150196', 'Планетарен миксер Bartscher 20L',         'Bartscher Planetary mixer 20L',         9, 'Bartscher','бр.',  1890.00,  2840.00, 1, 'Планетарен 20L, 3 приставки'),

  -- 10. Кафе машини и мелнички
  ('LAM-LM22',   'Кафемашина La Marzocco Linea Mini',       'La Marzocco Linea Mini',               10, 'La Marzocco','бр.',7890.00, 11990.00, 1, '1-група, двоен бойлер'),
  ('HEN-208603', 'Кафемашина Hendi професионална 2 групи',  'Hendi Pro Espresso 2-group',           10, 'Hendi',    'бр.',  2890.00,  4390.00, 1, '2 групи, 11L бойлер'),
  ('MAZ-SJ',     'Мелничка Mazzer Super Jolly',             'Mazzer Super Jolly grinder',           10, 'Mazzer',   'бр.',   980.00,  1490.00, 2, 'Мелничка за еспресо, 64мм нож'),

  -- 11. Работни маси и рафтове
  ('HEN-811047', 'Работна маса инокс 1200×700×850',         'Work table stainless 1200×700×850',    11, 'Hendi',    'бр.',   280.00,   420.00, 5, 'Инокс маса, 2 нива'),
  ('HEN-811085', 'Работна маса инокс 1800×700×850',         'Work table stainless 1800×700×850',    11, 'Hendi',    'бр.',   380.00,   580.00, 4, 'Инокс маса с рафт'),
  ('BAR-601102', 'Стенен рафт Bartscher 1000×300',          'Bartscher wall shelf 1000×300',        11, 'Bartscher','бр.',   120.00,   190.00, 8, 'Инокс стенен рафт'),

  -- 12. Неутрално оборудване
  ('HEN-812111', 'Мивка 1 корито инокс 600×600',            'Single bowl sink 600×600',             12, 'Hendi',    'бр.',   220.00,   340.00, 4, 'Инокс мивка 1 корито'),
  ('HEN-812128', 'Мивка 2 корита инокс 1200×600',           'Double bowl sink 1200×600',            12, 'Hendi',    'бр.',   340.00,   520.00, 3, 'Инокс мивка 2 корита'),

  -- 13. Инвентар и съдове
  ('HEN-632062', 'Гастронорм GN1/1 дълбочина 65мм',         'Gastronorm GN1/1 depth 65mm',          13, 'Hendi',    'бр.',    18.00,    28.00, 20, 'Неръждаем GN1/1 x 65мм'),
  ('HEN-632109', 'Гастронорм GN1/1 дълбочина 100мм',        'Gastronorm GN1/1 depth 100mm',         13, 'Hendi',    'бр.',    22.00,    34.00, 20, 'Неръждаем GN1/1 x 100мм'),
  ('HEN-632209', 'Гастронорм GN1/2 дълбочина 100мм',        'Gastronorm GN1/2 depth 100mm',         13, 'Hendi',    'бр.',    14.00,    22.00, 25, 'Неръждаем GN1/2 x 100мм'),
  ('HEN-516850', 'Професионален нож готварски 25см',        'Chef knife 25cm',                      13, 'Hendi',    'бр.',    32.00,    49.00, 15, 'Готварски нож 25 см'),
  ('FIA-D301',   'Чиния Fiamma порцелан 27см',              'Fiamma porcelain plate 27cm',          13, 'Fiamma',   'бр.',     6.50,    11.00, 50, 'Бял порцелан, ръб'),

  -- 14. Шоколадови и сладкарски машини
  ('BAR-135075', 'Темперираща машина Bartscher 6kg',        'Bartscher Chocolate temperer 6kg',     14, 'Bartscher','бр.',  1290.00,  1940.00, 1, 'Темперираща 6кг, 3 температури'),
  ('HEN-280329', 'Поставка за шоколад Hendi 3-отделения',   'Hendi chocolate warmer 3-section',     14, 'Hendi',    'бр.',   420.00,   640.00, 2, '3 отделения с индивидуален контрол'),

  -- 15. Барово оборудване
  ('HEN-224151', 'Бар хладилник 2 врати стъкло',            'Bar fridge 2 glass doors',             15, 'Hendi',    'бр.',   980.00,  1490.00, 2, 'Хладилник с двойно стъкло'),
  ('BAR-700275', 'Ледогенератор Bartscher Q46',             'Bartscher Ice maker Q46',              15, 'Bartscher','бр.',  1190.00,  1790.00, 2, 'Ледогенератор 46кг/24ч'),
  ('HEN-593005', 'Шейкър Boston инокс 800мл',               'Boston shaker stainless 800ml',        15, 'Hendi',    'бр.',    18.00,    29.00, 20, 'Класически бостън шейкър')
ON CONFLICT (sku) DO NOTHING;


-- ============================================================
-- INVENTORY (stock for each product in warehouse_id=1)
-- Quantities roughly correlated to low_stock_threshold:
-- smaller, expensive items → fewer units; consumables → more.
-- ============================================================
INSERT INTO inventory (product_id, warehouse_id, quantity)
SELECT p.id, 1, CASE
  WHEN p.selling_price > 5000 THEN 2 + (p.id % 3)      -- big-ticket: 2-4
  WHEN p.selling_price > 1500 THEN 5 + (p.id % 6)      -- mid-range: 5-10
  WHEN p.selling_price > 500  THEN 8 + (p.id % 10)     -- low-range: 8-17
  ELSE 30 + (p.id % 40)                                -- consumables: 30-70
END
FROM products p
ON CONFLICT (product_id, warehouse_id) WHERE batch_id IS NULL DO UPDATE SET quantity = EXCLUDED.quantity;


-- ============================================================
-- PARTNERS (Bulgarian HoReCa customers)
-- ============================================================
INSERT INTO partners (name, eik, vat_number, city, address, contact_person, phone, email, partner_type, payment_days, discount_percent)
VALUES
  ('Ресторант Манастирска изба ООД',  '103456789','BG103456789','София',  'ул. Граф Игнатиев 23, София',             'Елена Петрова',    '02 9871234', 'manager@manastirska.bg', 'customer', 30,  5.0),
  ('Хотел Рила АД',                    '103567890','BG103567890','Боровец','Курорт Боровец, Хотел Рила',              'Димитър Стоянов',  '07128 12345','office@hotelrila.bg',    'customer', 30,  8.0),
  ('Пицария Виа Виа ЕООД',             '103678901','BG103678901','София',  'бул. Витоша 105, София',                  'Антон Костадинов', '02 9876521', 'order@viavia.bg',        'customer', 14,  5.0),
  ('Кафе Арома ЕООД',                  '103789012','BG103789012','Пловдив','ул. Княз Александър I 12, Пловдив',       'Камелия Иванова',  '032 654321', 'info@caffearoma.bg',     'customer', 21,  5.0),
  ('Ресторант Рибата на Колката ООД',  '103890123','BG103890123','Созопол','ул. Морска 18, Созопол',                  'Николай Колев',    '055012345',  'info@ribatakolk.bg',     'customer', 14,  3.0),
  ('Кетъринг БГ ЕООД',                 '103901234','BG103901234','София',  'бул. Цариградско шосе 98, София',         'Росица Димитрова', '02 9874455', 'office@cateringbg.bg',   'customer', 30, 10.0),
  ('Хотел Сияние АД',                  '104012345','BG104012345','Банско', 'ул. Цар Симеон 56, Банско',               'Валери Симеонов',  '074912345',  'management@siyanie.bg',  'customer', 30,  8.0),
  ('Пекарна Класика ЕООД',             '104123456','BG104123456','Варна',  'бул. Княз Борис I 52, Варна',             'Цветан Георгиев',  '052 123456', 'sales@klassika-bakery.bg','customer', 14,  5.0),
  ('Ресторант Хаджидрагана ООД',       '104234567','BG104234567','София',  'ул. Георги Раковски 113, София',          'Стефан Хаджиев',   '02 9889977', 'office@hadjidragan.bg',  'customer', 30,  7.0),
  ('Бар Кикбол ЕООД',                  '104345678','BG104345678','София',  'ул. Солунска 12, София',                  'Мария Стефанова',  '0888 112233','bar@kickboll.bg',        'customer',  7,  3.0),
  ('Ресторант Мадона ООД',             '104456789','BG104456789','Пловдив','ул. Митрополит Панарет 3, Пловдив',       'Павел Николов',    '032 998877', 'reservations@madona.bg', 'customer', 21,  5.0),
  ('Хотел Черно море АД',              '104567890','BG104567890','Варна',  'бул. Сливница 33, Варна',                 'Ирина Василева',   '052 334455', 'frontdesk@chernomore.bg','customer', 30,  8.0),
  ('Пицария Ню Йорк ЕООД',             '104678901','BG104678901','Бургас', 'ул. Александровска 21, Бургас',           'Бояна Колева',     '056 123456', 'order@nypizza.bg',       'customer', 14,  5.0),
  ('Кафене Старата липа ЕООД',         '104789012','BG104789012','Велико Търново','ул. Стефан Стамболов 45, Велико Търново','Христо Илиев','062 123456', 'info@staratalipa.bg',    'customer', 14,  3.0),
  ('Ресторант Български места ООД',    '104890123','BG104890123','София',  'бул. Евлоги Георгиев 90, София',          'Александра Димитрова','02 9871122','office@bulgarskimesta.bg','customer', 30,  7.0),
  ('Кетъринг ВИП ООД',                 '104901234','BG104901234','София',  'бул. Христо Ботев 10, София',             'Владимир Николов', '02 9863344', 'office@vipcatering.bg',  'customer', 30, 10.0),
  ('Хотел Централ Форум АД',           '105012345','BG105012345','София',  'бул. Цар Освободител 4, София',           'Надя Петрова',     '02 9334400', 'reservations@centralforum.bg','customer',30,10.0),
  ('Ресторант Шипка ЕООД',             '105123456','BG105123456','Стара Загора','ул. Цар Симеон Велики 128, Стара Загора','Деян Колев','042 123456','info@shipka-rest.bg',   'customer', 21,  5.0),
  ('Бар Стенд Ъп ЕООД',                '105234567','BG105234567','София',  'ул. Ангел Кънчев 20, София',              'Симеон Пенков',    '0887 445566','bar@standup.bg',         'customer',  7,  3.0),
  ('Ресторант Олимп ООД',              '105345678','BG105345678','Пловдив','ул. Руски 15, Пловдив',                   'Теодора Стоилова', '032 445566', 'manager@olimp-rest.bg',  'customer', 30,  7.0);


COMMIT;

-- Sanity check
SELECT 'suppliers' tbl, COUNT(*) cnt FROM suppliers
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'inventory rows', COUNT(*) FROM inventory
UNION ALL SELECT 'partners', COUNT(*) FROM partners;
