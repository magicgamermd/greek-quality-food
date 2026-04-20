-- Migration: Add product categories and assign products to them
-- Categories from business requirements (handwritten list)

-- Step 1: Clear existing categories (if any) and insert the 10 defined categories
TRUNCATE categories CASCADE;

-- Reset the sequence
ALTER SEQUENCE categories_id_seq RESTART WITH 1;

INSERT INTO categories (id, name_bg, name_en) VALUES
  (1,  'Зехтин и Маслини',                'Olive Oil & Olives'),
  (2,  'Паста и Тестени Продукти',         'Pasta & Dough Products'),
  (3,  'Халва и Тахан',                    'Halva & Tahini'),
  (4,  'Сирена и Млечни Продукти',         'Cheese & Dairy Products'),
  (5,  'Колбаси',                          'Deli Meats & Sausages'),
  (6,  'Печива',                           'Baked Goods & Pastries'),
  (7,  'Сладки и Соленки',                 'Sweets & Salty Snacks'),
  (8,  'Сладолед',                         'Ice Cream'),
  (9,  'Безалкохолни Напитки и Вода',      'Soft Drinks & Water'),
  (10, 'Узо, Ципуро и Вино',              'Ouzo, Tsipouro & Wine');

-- Advance the sequence past our manually assigned IDs
SELECT setval('categories_id_seq', 10);

-- Step 2: Reset all product categories first
UPDATE products SET category_id = NULL;

-- ============================================================
-- Category 1: Зехтин и Маслини (Olive Oil & Olives)
-- ============================================================
UPDATE products SET category_id = 1
WHERE category_id IS NULL AND (
  name_bg ILIKE '%зехтин%'
  OR name_bg ILIKE '%маслин%'
  OR name_bg ILIKE '%маслинов%'
  OR name_bg ILIKE '%olive%'
  OR name_bg ILIKE '%kalamata%' AND name_bg NOT ILIKE '%паста%' AND name_bg NOT ILIKE '%торта%' AND name_bg NOT ILIKE '%кейк%'
  OR name_bg ILIKE '%критамос%'
  OR name_bg ILIKE '%каперси%'
  OR name_bg ILIKE '%салатно олио%'
  OR name_bg ILIKE '%слънчогледово олио%'
  OR name_bg ILIKE '%маслиново масло%'
  OR name_bg ILIKE '%помпа за зехтин%'
);

-- ============================================================
-- Category 2: Паста и Тестени Продукти (Pasta & Dough Products)
-- ============================================================
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND (
  name_bg ILIKE '%паста%' AND name_bg NOT ILIKE '%маслинова паста%' AND name_bg NOT ILIKE '%каламата паста%' AND name_bg NOT ILIKE '%паста делукс%' AND name_bg NOT ILIKE '%паста флора%' AND name_bg NOT ILIKE '%триъгълна паста%'
  OR name_bg ILIKE '%спагети%'
  OR name_bg ILIKE '%спагетини%'
  OR name_bg ILIKE '%макарони%'
  OR name_bg ILIKE '%пене %'
  OR name_bg ILIKE '%пенне%'
  OR name_bg ILIKE '%фиде %'
  OR name_bg ILIKE '%юфка%'
  OR name_bg ILIKE '%талиатели%'
  OR name_bg ILIKE '%лингуини%'
  OR name_bg ILIKE '%критараки%'
  OR name_bg ILIKE '%фусили%'
  OR name_bg ILIKE '%панделка%' AND name_bg NOT ILIKE '%локум%'
  OR name_bg ILIKE '%кус кус%'
  OR name_bg ILIKE '%трахана%'
  OR name_bg ILIKE '%булгур%'
  OR name_bg ILIKE '%кори за%'
  OR name_bg ILIKE '%кадаиф%' AND name_bg NOT ILIKE '%кадаифчета%' AND name_bg NOT ILIKE '%екмек кадаиф%'
  OR name_bg ILIKE '%ориз%' AND name_bg NOT ILIKE '%спанак с ориз%' AND name_bg NOT ILIKE '%хрупкав ориз%'
  OR name_bg ILIKE '%леща%' AND name_bg NOT ILIKE '%леща със%'
  OR name_bg ILIKE '%боб %' AND name_bg NOT ILIKE '%боб -%' AND name_bg NOT ILIKE '%боб гигант%' AND name_bg NOT ILIKE '%боб червен%' AND name_bg NOT ILIKE '%зелен боб%' AND name_bg NOT ILIKE '%боб със%' AND name_bg NOT ILIKE '%боб черно%'
  OR name_bg ILIKE '%нахут%' AND name_bg NOT ILIKE '%супа от нахут%'
  OR name_bg ILIKE '%фава %'
  OR name_bg ILIKE '%евристо%'
  OR name_bg ILIKE '%жито белено%'
  OR name_bg ILIKE '%осприада%'
  OR name_bg ILIKE '%ospriada%'
  OR name_bg ILIKE '%agrozimi%' AND name_bg NOT ILIKE '%супа%'
  OR name_bg ILIKE '%брашно%'
  OR name_bg ILIKE '%грис %' AND name_bg NOT ILIKE '%грис халва%'
  OR name_bg ILIKE '%бакпулвер%'
  OR name_bg ILIKE '%пудра захар%'
  OR name_bg ILIKE '%захар %' AND name_bg NOT ILIKE '%без захар%' AND name_bg NOT ILIKE '%канела и захар%'
  OR name_bg ILIKE '%захар "%'
  OR name_bg ILIKE '%сода за готвене%'
  OR name_bg ILIKE '%кувертюр%'
  OR name_bg ILIKE '%какао %' AND name_bg NOT ILIKE '%мляко с какао%'
  OR name_bg ILIKE '%ванилин%'
  OR name_bg ILIKE '%ванилия пръчка%'
  OR name_bg ILIKE '%кондензирано мляко%'
  OR name_bg ILIKE '%бешамел%'
  OR name_bg ILIKE '%бульон%'
  OR name_bg ILIKE '%доматено пюре%'
  OR name_bg ILIKE '%домати белени%'
  OR name_bg ILIKE '%домати смляни%'
  OR name_bg ILIKE '%pummaro%'
  OR name_bg ILIKE '%лозови листа%'
  OR name_bg ILIKE '%лозови сърми%'
  OR name_bg ILIKE '%passata%'
  OR name_bg ILIKE '%горчиза%'
  OR name_bg ILIKE '%горчица%'
  OR name_bg ILIKE '%кетчуп%'
  OR name_bg ILIKE '%майонеза%'
  OR name_bg ILIKE '%сос от горчица%'
  OR name_bg ILIKE '%оцет%' AND name_bg NOT ILIKE '%балсам%'
  OR name_bg ILIKE '%балсам%'
  OR name_bg ILIKE '%мармалад%'
  OR name_bg ILIKE '%сладко папа%'
  OR name_bg ILIKE '%мед от%'
  OR name_bg ILIKE '%крем мед%'
  OR name_bg ILIKE '%меренда %'
  OR name_bg ILIKE '%сушен домат%'
  OR name_bg ILIKE '%сушени домати%'
  OR name_bg ILIKE '%печен патладжан%'
  OR name_bg ILIKE '%туршия%'
  OR name_bg ILIKE '%кисели краставички%'
  OR name_bg ILIKE '%чушки %' AND name_bg NOT ILIKE '%чушки пълнени%'
  OR name_bg ILIKE '%пикантно марин%'
  OR name_bg ILIKE '%червено цвекло%'
  OR name_bg ILIKE '%царевица сладка%'
  OR name_bg ILIKE '%гъби нарязани%'
  OR name_bg ILIKE '%боб гигант%'
  OR name_bg ILIKE '%боб червен%'
  OR name_bg ILIKE '%боб черно око%'
  OR name_bg ILIKE '%боб едър%'
  OR name_bg ILIKE '%боб нормален%'
  OR name_bg ILIKE '%боб със%'
  OR name_bg ILIKE '%боб -%'
  OR name_bg ILIKE '%зелен боб%'
  OR name_bg ILIKE '%леща със%'
  OR name_bg ILIKE '%супа от нахут%'
  OR name_bg ILIKE '%супа с гъби%'
  OR name_bg ILIKE '%стафида%'
  OR name_bg ILIKE '%сол морска%'
  OR name_bg ILIKE '%морска сол%'
  OR name_bg ILIKE '%хималайска сол%'
  OR name_bg ILIKE '%сол %' AND name_bg ILIKE '%гр.%'
  OR name_bg ILIKE '%черна индийска%'
  OR name_bg ILIKE '%карамелизиран лук%'
  OR name_bg ILIKE '%салца%'
  OR name_bg ILIKE '%песто%'
  OR name_bg ILIKE '%желе %'
  OR name_bg ILIKE '%лукумадес%'
  OR name_bg ILIKE '%локум%'
  OR name_bg ILIKE '%бяло сладко%'
);

-- ============================================================
-- Category 2 extended: Подправки (Spices) - also under Паста и Тестени
-- ============================================================
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND (
  name_bg ILIKE '%риган%' AND name_bg NOT ILIKE '%наденица с риган%' AND name_bg NOT ILIKE '%филе с риган%' AND name_bg NOT ILIKE '%печен с риган%' AND name_bg NOT ILIKE '%пушено филе с риган%' AND name_bg NOT ILIKE '%с маслини и риган%'
  OR name_bg ILIKE '%босилек%' AND name_bg NOT ILIKE '%скилидки%'
  OR name_bg ILIKE '%канела %' AND name_bg NOT ILIKE '%кроасан%' AND name_bg NOT ILIKE '%мъфин%' AND name_bg NOT ILIKE '%ябълка и канела%' AND name_bg NOT ILIKE '%с канела%'
  OR name_bg ILIKE '%пипер %' AND name_bg ILIKE '%гр.%'
  OR name_bg ILIKE '%черен пипер%'
  OR name_bg ILIKE '%бял пипер%'
  OR name_bg ILIKE '%розов пипер%'
  OR name_bg ILIKE '%зелен пипер%' AND name_bg ILIKE '%зърна%'
  OR name_bg ILIKE '%микс пипер%'
  OR name_bg ILIKE '%микс 4 пипера%'
  OR name_bg ILIKE '%червен пипер%' AND name_bg NOT ILIKE '%наденица%' AND name_bg NOT ILIKE '%салам%'
  OR name_bg ILIKE '%кимион%'
  OR name_bg ILIKE '%къри%'
  OR name_bg ILIKE '%кориандър%'
  OR name_bg ILIKE '%коркума%'
  OR name_bg ILIKE '%куркума%'
  OR name_bg ILIKE '%карамфил%' AND name_bg NOT ILIKE '%чай%'
  OR name_bg ILIKE '%кардамон%'
  OR name_bg ILIKE '%бахар%'
  OR name_bg ILIKE '%анасон%' AND name_bg NOT ILIKE '%ципуро%' AND name_bg NOT ILIKE '%чай%'
  OR name_bg ILIKE '%дафинов лист%'
  OR name_bg ILIKE '%джинджифил%'
  OR name_bg ILIKE '%джоджен%'
  OR name_bg ILIKE '%мащерка%' AND name_bg NOT ILIKE '%мед от%' AND name_bg NOT ILIKE '%сирене с мащерка%'
  OR name_bg ILIKE '%розмаранин%'
  OR name_bg ILIKE '%майорана%'
  OR name_bg ILIKE '%луиза%'
  OR name_bg ILIKE '%сусам%' AND name_bg NOT ILIKE '%геврек%' AND name_bg NOT ILIKE '%бисквити%' AND name_bg NOT ILIKE '%пръчици%' AND name_bg NOT ILIKE '%пай%'
  OR name_bg ILIKE '%шафран%'
  OR name_bg ILIKE '%мастиха хиос%'
  OR name_bg ILIKE '%махлепи%'
  OR name_bg ILIKE '%индийско орехче%'
  OR name_bg ILIKE '%сумак%'
  OR name_bg ILIKE '%кедрови ядки%'
  OR name_bg ILIKE '%микс за%'
  OR name_bg ILIKE '%подправка%'
  OR name_bg ILIKE '%чесън %' AND name_bg NOT ILIKE '%скилидки%'
  OR name_bg ILIKE '%градински чай%'
  OR name_bg ILIKE '%салепи%'
  OR name_bg ILIKE '%дафинов%'
  OR name_bg ILIKE '%морсалски чай%'
  OR name_bg ILIKE '%боя за яйца%'
);

-- ============================================================
-- Category 3: Халва и Тахан (Halva & Tahini)
-- ============================================================
UPDATE products SET category_id = 3
WHERE category_id IS NULL AND (
  name_bg ILIKE '%халва%'
  OR name_bg ILIKE '%halva%'
  OR name_bg ILIKE '%тахан%'
  OR name_bg ILIKE '%tachini%'
  OR name_bg ILIKE '%tахан%'
  OR name_bg ILIKE '%грис халва%'
  OR name_bg ILIKE '%sisinni%'
  OR name_bg ILIKE '%фастъчено масло%'
  OR name_bg ILIKE '%сусамов тахан%'
  OR name_bg ILIKE '%вафлички с таханов%'
  OR name_bg ILIKE '%вафлички с фъстъчен%'
  OR name_bg ILIKE '%сусамови блокчета%'
);

-- ============================================================
-- Category 4: Сирена и Млечни Продукти (Cheese & Dairy Products)
-- ============================================================
UPDATE products SET category_id = 4
WHERE category_id IS NULL AND (
  name_bg ILIKE '%сирене%'
  OR name_bg ILIKE '%сирена%'
  OR name_bg ILIKE '%фета%' AND name_bg NOT ILIKE '%баница%' AND name_bg NOT ILIKE '%бутер%' AND name_bg NOT ILIKE '%туистър%'
  OR name_bg ILIKE '%гравиера%'
  OR name_bg ILIKE '%graviera%'
  OR name_bg ILIKE '%кашери%' AND name_bg NOT ILIKE '%бисквити%'
  OR name_bg ILIKE '%кашкавал%'
  OR name_bg ILIKE '%кефалотири%'
  OR name_bg ILIKE '%халуми%'
  OR name_bg ILIKE '%манури%'
  OR name_bg ILIKE '%антотиро%'
  OR name_bg ILIKE '%мизитра%'
  OR name_bg ILIKE '%мецовоне%'
  OR name_bg ILIKE '%ладотири%'
  OR name_bg ILIKE '%мелихлоро%'
  OR name_bg ILIKE '%пекорино%'
  OR name_bg ILIKE '%талагани%'
  OR name_bg ILIKE '%саганаки%'
  OR name_bg ILIKE '%гауда%' AND name_bg NOT ILIKE '%баница%'
  OR name_bg ILIKE '%кисело мляко%'
  OR name_bg ILIKE '%козе мляко%'
  OR name_bg ILIKE '%краве мляко%'
  OR name_bg ILIKE '%мляко%' AND (name_bg ILIKE '%farma%' OR name_bg ILIKE '%royal%' OR name_bg ILIKE '%neogal%')
  OR name_bg ILIKE '%цедено%'
  OR name_bg ILIKE '%едесма кисело%'
  OR name_bg ILIKE '%айрян%'
  OR name_bg ILIKE '%кефир%'
  OR name_bg ILIKE '%крема сирене%'
  OR name_bg ILIKE '%козе сирене%'
  OR name_bg ILIKE '%краве сирене%'
  OR name_bg ILIKE '%козе elason%'
  OR name_bg ILIKE '%краве масло%'
  OR name_bg ILIKE '%овче-козе масло%'
  OR name_bg ILIKE '%млечна сметана%'
  OR name_bg ILIKE '%цеден десерт%'
  OR name_bg ILIKE '%мляко с какао%'
  OR name_bg ILIKE '%мляко с ориз%'
  OR name_bg ILIKE '%крем ванилия%' AND name_bg ILIKE '%farma%'
  OR name_bg ILIKE '%крем шоколад%' AND name_bg ILIKE '%farma%'
  OR name_bg ILIKE '%постно сирене%'
  OR name_bg ILIKE '%аневато%'
);

-- ============================================================
-- Category 5: Колбаси (Deli Meats & Sausages)
-- ============================================================
UPDATE products SET category_id = 5
WHERE category_id IS NULL AND (
  name_bg ILIKE '%наденица%' AND name_bg NOT ILIKE '%баница%' AND name_bg NOT ILIKE '%гнездо с колбаси%' AND name_bg NOT ILIKE '%геврек%mini%колбаси%'
  OR name_bg ILIKE '%наденички%'
  OR name_bg ILIKE '%салам%' AND name_bg NOT ILIKE '%сладък салам%'
  OR name_bg ILIKE '%колбас%'
  OR name_bg ILIKE '%пастърма%'
  OR name_bg ILIKE '%pastrami%'
  OR name_bg ILIKE '%пастрами%'
  OR name_bg ILIKE '%прошуто%'
  OR name_bg ILIKE '%prosciutto%'
  OR name_bg ILIKE '%мортадела%'
  OR name_bg ILIKE '%паризаки%'
  OR name_bg ILIKE '%шунка%' AND name_bg NOT ILIKE '%баница%' AND name_bg NOT ILIKE '%пица%' AND name_bg NOT ILIKE '%пенерли%'
  OR name_bg ILIKE '%свинск%' AND (name_bg ILIKE '%пушен%' OR name_bg ILIKE '%печен%' OR name_bg ILIKE '%филе%' OR name_bg ILIKE '%стек%' OR name_bg ILIKE '%джулан%' OR name_bg ILIKE '%пържол%' OR name_bg ILIKE '%кремвирш%')
  OR name_bg ILIKE '%телешк%' AND (name_bg ILIKE '%суджук%' OR name_bg ILIKE '%език%' OR name_bg ILIKE '%кебаб%' OR name_bg ILIKE '%саздърма%' OR name_bg ILIKE '%пастърма%' OR name_bg ILIKE '%пастрами%' OR name_bg ILIKE '%наденица%')
  OR name_bg ILIKE '%суджук%'
  OR name_bg ILIKE '%кюрмузур%'
  OR name_bg ILIKE '%сиглино%'
  OR name_bg ILIKE '%овча пастърма%'
  OR name_bg ILIKE '%пуешко филе%'
  OR name_bg ILIKE '%mouchteron%'
  OR name_bg ILIKE '%pork grilled%'
  OR name_bg ILIKE '%beef%pastrami%'
  OR name_bg ILIKE '%le grand beef%'
  OR name_bg ILIKE '%ΛΟΥΚΑΝΙΚΟ%'
  OR name_bg ILIKE '%ΜΠΡΙΖΟΛΑ%'
  OR name_bg ILIKE '%ΠΡΟΣΟΥΤΟ%'
  OR name_bg ILIKE '%ΣΑΛΑΜΙ%'
  OR name_bg ILIKE '%λΟΥΚΑΝΙΚΟ%'
  OR name_bg ILIKE '%салата%' AND (name_bg ILIKE '%дзадзики%' OR name_bg ILIKE '%тзатзики%' OR name_bg ILIKE '%тарама%' OR name_bg ILIKE '%тирокафтери%' OR name_bg ILIKE '%тиросалата%' OR name_bg ILIKE '%хтипити%' OR name_bg ILIKE '%хумус%' OR name_bg ILIKE '%кьопоолу%' OR name_bg ILIKE '%мелиджано%' OR name_bg ILIKE '%паприка%' OR name_bg ILIKE '%скордал%' OR name_bg ILIKE '%руска%' OR name_bg ILIKE '%будапещ%' OR name_bg ILIKE '%фермерска%' OR name_bg ILIKE '%унгарска%' OR name_bg ILIKE '%риба тон%' OR name_bg ILIKE '%пиле%' OR name_bg ILIKE '%цвекло%')
  OR name_bg ILIKE '%хайвер%'
  OR name_bg ILIKE '%мезе за узо%'
  OR name_bg ILIKE '%микс за узо%'
  OR name_bg ILIKE '%неразбит хайвер%'
);

-- ============================================================
-- Category 5 extended: Риба и Морски Продукти (also under Колбаси)
-- ============================================================
UPDATE products SET category_id = 5
WHERE category_id IS NULL AND (
  name_bg ILIKE '%сардина%'
  OR name_bg ILIKE '%сардини%'
  OR name_bg ILIKE '%риба тон%'
  OR name_bg ILIKE '%калмари%'
  OR name_bg ILIKE '%октопод%'
  OR name_bg ILIKE '%аншоа%'
  OR name_bg ILIKE '%бакалиаро%'
  OR name_bg ILIKE '%скумрия%'
  OR name_bg ILIKE '%филе от гаврос%'
  OR name_bg ILIKE '%филе от гаврус%'
  OR name_bg ILIKE '%чируз%'
  OR name_bg ILIKE '%тонолакерда%'
  OR name_bg ILIKE '%филе от риба%'
  OR name_bg ILIKE '%mixed salad%'
);

-- ============================================================
-- Category 6: Печива (Baked Goods & Pastries)
-- ============================================================
UPDATE products SET category_id = 6
WHERE category_id IS NULL AND (
  name_bg ILIKE '%баница%'
  OR name_bg ILIKE '%бугаца%'
  OR name_bg ILIKE '%bougatsa%'
  OR name_bg ILIKE '%кроасан%'
  OR name_bg ILIKE '%croissant%'
  OR name_bg ILIKE '%cornrtti%'
  OR name_bg ILIKE '%геврек%' AND name_bg NOT ILIKE '%хрупкав геврек%' AND name_bg NOT ILIKE '%пълнозърнест хрупкав%' AND name_bg NOT ILIKE '%многозърнест хрупкав%'
  OR name_bg ILIKE '%bread ring%'
  OR name_bg ILIKE '%bread stick%'
  OR name_bg ILIKE '%багета%'
  OR name_bg ILIKE '%baguette%'
  OR name_bg ILIKE '%хляб%'
  OR name_bg ILIKE '%панини%'
  OR name_bg ILIKE '%пица%'
  OR name_bg ILIKE '%pizzarto%'
  OR name_bg ILIKE '%пенерли%'
  OR name_bg ILIKE '%пейнирли%'
  OR name_bg ILIKE '%peinirli%'
  OR name_bg ILIKE '%бриош%'
  OR name_bg ILIKE '%донът%'
  OR name_bg ILIKE '%donut%'
  OR name_bg ILIKE '%поничка%'
  OR name_bg ILIKE '%мъфин%'
  OR name_bg ILIKE '%muffin%'
  OR name_bg ILIKE '%бюрек%'
  OR name_bg ILIKE '%пай с пиле%'
  OR name_bg ILIKE '%strudel%'
  OR name_bg ILIKE '%puff pastri%'
  OR name_bg ILIKE '%ring with turkey%'
  OR name_bg ILIKE '%sausage pie%'
  OR name_bg ILIKE '%stick with potato%'
  OR name_bg ILIKE '%handmade pie%'
  OR name_bg ILIKE '%traditional pie%'
  OR name_bg ILIKE '%triangle pie%'
  OR name_bg ILIKE '%multigrain bakery%'
  OR name_bg ILIKE '%козунак%'
  OR name_bg ILIKE '%tsoureki%'
  OR name_bg ILIKE '%панетоне%'
  OR name_bg ILIKE '%мини кроасан%'
  OR name_bg ILIKE '%кукис%' AND name_bg NOT ILIKE '%орехови кукис%'
  OR name_bg ILIKE '%cookie%'
  OR name_bg ILIKE '%cookies%' AND name_bg NOT ILIKE '%кейк%' AND name_bg NOT ILIKE '%торта%' AND name_bg NOT ILIKE '%десерт%'
  OR name_bg ILIKE '%бисквит%' AND name_bg NOT ILIKE '%кейк%' AND name_bg NOT ILIKE '%торта%' AND name_bg NOT ILIKE '%шоколад%бисквит%'
  OR name_bg ILIKE '%сухар%'
  OR name_bg ILIKE '%ечемичен сухар%'
  OR name_bg ILIKE '%бейгъл%'
  OR name_bg ILIKE '%bagel%'
  OR name_bg ILIKE '%брауни%' AND name_bg NOT ILIKE '%кейк%' AND name_bg NOT ILIKE '%торта%'
  OR name_bg ILIKE '%brownie%' AND name_bg NOT ILIKE '%cake%' AND name_bg NOT ILIKE '%торта%'
  OR name_bg ILIKE '%walnut brownie%'
  OR name_bg ILIKE '%калцоне%'
  OR name_bg ILIKE '%бутер баница%'
  OR name_bg ILIKE '%бутер пай%'
  OR name_bg ILIKE '%туистър%'
  OR name_bg ILIKE '%триъгълна бутер%'
  OR name_bg ILIKE '%домашна баница%'
  OR name_bg ILIKE '%гръцка баница%'
  OR name_bg ILIKE '%мини бугаца%'
  OR name_bg ILIKE '%катепсигмени%'
  OR name_bg ILIKE '%frozen baguette%'
  OR name_bg ILIKE '%солунски геврек%'
  OR name_bg ILIKE '%многозърнест%геврек%' AND name_bg NOT ILIKE '%хрупкав%'
  OR name_bg ILIKE '%пълнозърнест%геврек%' AND name_bg NOT ILIKE '%хрупкав%'
  OR name_bg ILIKE '%гнездо с колбаси%'
  OR name_bg ILIKE '%геврек%mini%'
);

-- ============================================================
-- Category 7: Сладки и Соленки (Sweets & Salty Snacks)
-- ============================================================
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND (
  -- Frozen desserts / торти / кейкове
  name_bg ILIKE '%торта%'
  OR name_bg ILIKE '%cake%'
  OR name_bg ILIKE '%кейк%'
  OR name_bg ILIKE '%десерт%'
  OR name_bg ILIKE '%dessert%'
  OR name_bg ILIKE '%тирамису%'
  OR name_bg ILIKE '%tiramisu%'
  OR name_bg ILIKE '%профитерол%'
  OR name_bg ILIKE '%profiterol%'
  OR name_bg ILIKE '%еклер%'
  OR name_bg ILIKE '%eclair%'
  OR name_bg ILIKE '%мил фей%'
  OR name_bg ILIKE '%mille feuille%'
  OR name_bg ILIKE '%чийзкейк%'
  OR name_bg ILIKE '%cheesecake%'
  OR name_bg ILIKE '%суфле%'
  OR name_bg ILIKE '%souffle%'
  OR name_bg ILIKE '%екмек%'
  OR name_bg ILIKE '%ekmek%'
  -- Siropiasta / сиропирани
  OR name_bg ILIKE '%баклава%'
  OR name_bg ILIKE '%baklava%'
  OR name_bg ILIKE '%сиропиран%'
  OR name_bg ILIKE '%кадаифчета%'
  OR name_bg ILIKE '%казан диби%'
  OR name_bg ILIKE '%каридопита%'
  OR name_bg ILIKE '%лемонопита%'
  OR name_bg ILIKE '%портокалопита%'
  OR name_bg ILIKE '%шоколатопита%'
  OR name_bg ILIKE '%галактобуреко%'
  OR name_bg ILIKE '%толумби%'
  OR name_bg ILIKE '%толумбички%'
  OR name_bg ILIKE '%финикаки%'
  OR name_bg ILIKE '%куркубиня%'
  OR name_bg ILIKE '%самали%'
  OR name_bg ILIKE '%сарагли%'
  OR name_bg ILIKE '%роксаки%'
  OR name_bg ILIKE '%рокс %'
  OR name_bg ILIKE '%реване%'
  OR name_bg ILIKE '%пръстчета%'
  OR name_bg ILIKE '%тригуни%'
  OR name_bg ILIKE '%роза %' AND name_bg NOT ILIKE '%сладко%роза%'
  OR name_bg ILIKE '%селско постно%'
  OR name_bg ILIKE '%островно сиропирано%'
  OR name_bg ILIKE '%нарязано сиропирано%'
  OR name_bg ILIKE '%меломакарона%'
  OR name_bg ILIKE '%курабии%'
  OR name_bg ILIKE '%лятни чашки%'
  OR name_bg ILIKE '%чашки %'
  OR name_bg ILIKE '%паста делукс%'
  OR name_bg ILIKE '%паста флора%'
  OR name_bg ILIKE '%тарталета%'
  OR name_bg ILIKE '%тарт %' AND name_bg NOT ILIKE '%шоколадов тарт%'
  OR name_bg ILIKE '%квадратен тарт%'
  OR name_bg ILIKE '%кръгъл тарт%'
  OR name_bg ILIKE '%гнездо с крем%'
  OR name_bg ILIKE '%гнездо с шоколад%'
  OR name_bg ILIKE '%гнездо с орехов%'
  -- Шоколади
  OR name_bg ILIKE '%шоколад%' AND name_bg NOT ILIKE '%мъфин%' AND name_bg NOT ILIKE '%кроасан%' AND name_bg NOT ILIKE '%кейк%' AND name_bg NOT ILIKE '%торта%' AND name_bg NOT ILIKE '%донът%' AND name_bg NOT ILIKE '%поничка%' AND name_bg NOT ILIKE '%козунак%' AND name_bg NOT ILIKE '%баница с шоколад%'
  OR name_bg ILIKE '%шок. бонбони%'
  OR name_bg ILIKE '%шокофрета%'
  OR name_bg ILIKE '%golden choco%'
  OR name_bg ILIKE '%golden handmade%'
  OR name_bg ILIKE '%chocolate pop%'
  OR name_bg ILIKE '%ion %' AND name_bg NOT ILIKE '%bread%'
  OR name_bg ILIKE '%lacta %'
  OR name_bg ILIKE '%млечен шоколад лакта%'
  OR name_bg ILIKE '%caprise%'
  -- Salty snacks / пръчици / соленки
  OR name_bg ILIKE '%хлебни пръчици%'
  OR name_bg ILIKE '%хрупкав геврек%'
  OR name_bg ILIKE '%хрупкави пръчици%'
  OR name_bg ILIKE '%многозърнест хрупкав%'
  OR name_bg ILIKE '%пълнозърнест хрупкав%'
  OR name_bg ILIKE '%многозърнести хлебни%'
  OR name_bg ILIKE '%пълнозърнести хлебни%'
  OR name_bg ILIKE '%средиземноморски хлебни%'
  OR name_bg ILIKE '%царевични хлебни%'
  OR name_bg ILIKE '%протеинови хлебни%'
  OR name_bg ILIKE '%пикантни хрупкави%'
  OR name_bg ILIKE '%овесени%пръчици%'
  OR name_bg ILIKE '%пръчици%' AND name_bg ILIKE '%vergidis%'
  OR name_bg ILIKE '%брецел%'
  OR name_bg ILIKE '%топчета със сирене%'
  OR name_bg ILIKE '%солени бисквити%'
  OR name_bg ILIKE '%батонсале%'
  OR name_bg ILIKE '%heart -%'
  OR name_bg ILIKE '%галета%'
  -- Protein / energy bars
  OR name_bg ILIKE '%protein bar%'
  OR name_bg ILIKE '%енергиен бар%'
  OR name_bg ILIKE '%bio овесено%'
  OR name_bg ILIKE '%БИО Овесено%'
  OR name_bg ILIKE '%карамелизирани бисквити%'
  -- Готови ястия (ready meals)
  OR name_bg ILIKE '%мусака%'
  OR name_bg ILIKE '%moussaka%'
  OR name_bg ILIKE '%пастицио%'
  OR name_bg ILIKE '%pastitsio%'
  OR name_bg ILIKE '%имам%'
  OR name_bg ILIKE '%imam%'
  OR name_bg ILIKE '%бриам%'
  OR name_bg ILIKE '%briam%'
  OR name_bg ILIKE '%домати и зелени чушки%'
  OR name_bg ILIKE '%gemista%'
  OR name_bg ILIKE '%спанак с ориз%'
  OR name_bg ILIKE '%spanakorizo%'
  OR name_bg ILIKE '%пиле с ориз%'
  OR name_bg ILIKE '%телешко месо с грах%'
  OR name_bg ILIKE '%кюфтета%'
  OR name_bg ILIKE '%soutzoukakia%'
  OR name_bg ILIKE '%селска наденица със зеленчуци%'
  OR name_bg ILIKE '%spetsofai%'
  OR name_bg ILIKE '%lahanodolmades%'
  OR name_bg ILIKE '%kolokithakia%'
  OR name_bg ILIKE '%пълнени чушки%'
  -- Karamela, misc sweets
  OR name_bg ILIKE '%karamela%'
  OR name_bg ILIKE '%орехови кукис%'
  OR name_bg ILIKE '%милфьой%'
  OR name_bg ILIKE '%ванилови мъфини%'
  OR name_bg ILIKE '%шоколадов мъфин%'
  OR name_bg ILIKE '%американски бисквитки%'
  OR name_bg ILIKE '%кокосова бисквитка%'
  OR name_bg ILIKE '%лимонов пай%'
  OR name_bg ILIKE '%mini tart%'
  OR name_bg ILIKE '%mixed cake%'
  OR name_bg ILIKE '%kok 170%'
  OR name_bg ILIKE '%мини kok%'
  OR name_bg ILIKE '%мини negraki%'
  OR name_bg ILIKE '%мини truffle%'
  OR name_bg ILIKE '%мини торта%'
  OR name_bg ILIKE '%sugar angel%'
  OR name_bg ILIKE '%elevated%'
  OR name_bg ILIKE '%premium chocolate%'
  OR name_bg ILIKE '%триъгълна паста%'
  OR name_bg ILIKE '%квадратна торта%'
  OR name_bg ILIKE '%кръгла торта%'
  OR name_bg ILIKE '%триъгълник от солун%'
  OR name_bg ILIKE '%великденски шоколад%'
  OR name_bg ILIKE '%коледен кейк%'
  OR name_bg ILIKE '%коледен козунак%'
  OR name_bg ILIKE '%коледна%'
  OR name_bg ILIKE '%новогодишна торта%'
  OR name_bg ILIKE '%василопита%'
  OR name_bg ILIKE '%петифури%'
  OR name_bg ILIKE '%портокалови резенчета%'
  OR name_bg ILIKE '%шоколадови пурички%'
  OR name_bg ILIKE '%шоколадов тарт%'
  OR name_bg ILIKE '%саварин%'
  OR name_bg ILIKE '%сладък салам%'
  OR name_bg ILIKE '%солен карамел%'
  OR name_bg ILIKE '%стъклено бурканче%'
  OR name_bg ILIKE '%чаша профитерол%'
  OR name_bg ILIKE '%чаша фереро%'
  OR name_bg ILIKE '%nini mosaic%'
  OR name_bg ILIKE '%bueno in bowl%'
  OR name_bg ILIKE '%speculoos%'
  OR name_bg ILIKE '%lava banana%'
  OR name_bg ILIKE '%морков торта%'
  OR name_bg ILIKE '%рафаело на тава%'
  OR name_bg ILIKE '%червено кадифе на тава%'
  OR name_bg ILIKE '%тираису на тава%'
  OR name_bg ILIKE '%ябълков пай%'
  OR name_bg ILIKE '%apple pie%'
  OR name_bg ILIKE '%mango yogurt%'
  OR name_bg ILIKE '%pantelka%'
  OR name_bg ILIKE '%laurence%'
  OR name_bg ILIKE '%pre-packed stand%'
);

-- ============================================================
-- Category 8: Сладолед (Ice Cream)
-- ============================================================
UPDATE products SET category_id = 8
WHERE category_id IS NULL AND (
  name_bg ILIKE '%сладолед%'
  OR name_bg ILIKE '%ice cream%'
  OR name_bg ILIKE '%сорбе%'
  OR name_bg ILIKE '%kaimaki%'
  OR name_bg ILIKE '%каимаки%'
  OR name_bg ILIKE '%planet %' AND (name_bg ILIKE '%52m%' OR name_bg ILIKE '%28m%' OR name_bg ILIKE '%20m%')
);

-- ============================================================
-- Category 9: Безалкохолни Напитки и Вода (Soft Drinks & Water)
-- ============================================================
UPDATE products SET category_id = 9
WHERE category_id IS NULL AND (
  name_bg ILIKE '%вода%' AND (name_bg ILIKE '%500%' OR name_bg ILIKE '%1.5%' OR name_bg ILIKE '%vikos%' OR name_bg ILIKE '%zagori%')
  OR name_bg ILIKE '%бода %'
  OR name_bg ILIKE '%coca cola%'
  OR name_bg ILIKE '%лимонада%'
  OR name_bg ILIKE '%lemonade%'
  OR name_bg ILIKE '%оранжада%'
  OR name_bg ILIKE '%orangeade%'
  OR name_bg ILIKE '%gazoze%'
  OR name_bg ILIKE '%rossolis%'
  OR name_bg ILIKE '%сода mr%'
  OR name_bg ILIKE '%epsa %'
  OR name_bg ILIKE '%сок от%'
  OR name_bg ILIKE '%енергийна напитка%'
  OR name_bg ILIKE '%безалкохолн%'
  -- Чай
  OR name_bg ILIKE '%чай %' AND name_bg NOT ILIKE '%градински чай%' AND name_bg NOT ILIKE '%морсалски чай%'
  OR name_bg ILIKE '%ЧАЙ %'
  -- Кафе
  OR name_bg ILIKE '%кафе%'
  OR name_bg ILIKE '%нес кафе%'
  OR name_bg ILIKE '%гръцко кафе%'
);

-- ============================================================
-- Category 10: Узо, Ципуро и Вино (Ouzo, Tsipouro & Wine)
-- ============================================================
UPDATE products SET category_id = 10
WHERE category_id IS NULL AND (
  name_bg ILIKE '%узо%'
  OR name_bg ILIKE '%ципуро%'
  OR name_bg ILIKE '%вино%' AND name_bg NOT ILIKE '%свинско%'
  OR name_bg ILIKE '%рецина%' AND name_bg NOT ILIKE '%празна бутилка%'
  OR name_bg ILIKE '%beer%'
  OR name_bg ILIKE '%бира%'
  OR name_bg ILIKE '%vergina%'
  OR name_bg ILIKE '%liquer%'
  OR name_bg ILIKE '%evropale%'
);

-- ============================================================
-- Category 9 for beer (move beer from 10 to 9 - user said безалкохолни but beers are separate)
-- Actually keep beer in 10 since it's alcoholic
-- ============================================================

-- Assign remaining food prep items to Category 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND (
  name_bg ILIKE '%зеленчуци спирала%'
  OR name_bg ILIKE '%царевично брашно%'
  OR name_bg ILIKE '%лимонов сок%'
  OR name_bg ILIKE '%скилидки чесън%'
  OR name_bg ILIKE '%chili peppers%'
  OR name_bg ILIKE '%hot chillis%'
  OR name_bg ILIKE '%камби pepelicious%'
  OR name_bg ILIKE '%чушки македония%'
);

-- ============================================================
-- Fix remaining matchable products
-- ============================================================

-- Маслинова Паста → Зехтин и Маслини (cat 1)
UPDATE products SET category_id = 1
WHERE category_id IS NULL AND name_bg ILIKE '%маслинова паста%';

-- Каламата Паста → Зехтин и Маслини (cat 1)
UPDATE products SET category_id = 1
WHERE category_id IS NULL AND name_bg ILIKE '%каламата паста%';

-- Пастет от Чушка → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%пастет от чушка%';

-- Пене Паста без глутен → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%пене паста%';

-- Спирала Зеленчуци → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%спирала зеленчуци%';

-- Панделка MELLISA → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%панделка%';

-- Желе без Захар → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%желе%';

-- Зелен Пипер на зърна → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%зелен пипер%';

-- Червен пипер лют → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%червен%пипер%лют%';

-- Микс от зеленчуци → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%микс от зеленчуци%';

-- Скилидки чесън → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%скилидки чесън%';

-- Балцамов крем → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%балцамов%';

-- Мед от Мащерка → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%мед от мащерка%';

-- Боб variants → cat 2
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%боб %';
UPDATE products SET category_id = 2
WHERE category_id IS NULL AND name_bg ILIKE '%боб(%';

-- Мизитра → cat 4
UPDATE products SET category_id = 4
WHERE category_id IS NULL AND (name_bg ILIKE '%mizithra%' OR name_bg ILIKE '%мизитра%');

-- Мляко Royal → cat 4
UPDATE products SET category_id = 4
WHERE category_id IS NULL AND name_bg ILIKE '%мляко "royal%';

-- Крем Ванилия/Карамел Farma → cat 4
UPDATE products SET category_id = 4
WHERE category_id IS NULL AND name_bg ILIKE '%крем ванилия%';
UPDATE products SET category_id = 4
WHERE category_id IS NULL AND name_bg ILIKE '%крем карамел%';

-- Свинско Пушено Филе → cat 5
UPDATE products SET category_id = 5
WHERE category_id IS NULL AND name_bg ILIKE '%свис%пушено%';

-- Kюрмузур with K → cat 5
UPDATE products SET category_id = 5
WHERE category_id IS NULL AND name_bg ILIKE '%кюрмузур%';
UPDATE products SET category_id = 5
WHERE category_id IS NULL AND name_bg ILIKE '%kюрмузур%';

-- Кадаиф (замразен) → cat 6
UPDATE products SET category_id = 6
WHERE category_id IS NULL AND name_bg ILIKE '%кадаиф%';

-- Handmade Pizza → cat 6
UPDATE products SET category_id = 6
WHERE category_id IS NULL AND name_bg ILIKE '%handmade pizza%';

-- Vegan Shredded Fillo → cat 6
UPDATE products SET category_id = 6
WHERE category_id IS NULL AND name_bg ILIKE '%vegan%fillo%';
UPDATE products SET category_id = 6
WHERE category_id IS NULL AND name_bg ILIKE '%vegan%kataifi%';

-- Панеттоне → cat 6
UPDATE products SET category_id = 6
WHERE category_id IS NULL AND name_bg ILIKE '%панеттоне%';

-- Chocolate Chip Twist → cat 6
UPDATE products SET category_id = 6
WHERE category_id IS NULL AND name_bg ILIKE '%chocolate chip twist%';

-- Кекс → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%кекс%';

-- FERRERINO/FRAGOLINO мини → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND (name_bg ILIKE '%ferrerino%' OR name_bg ILIKE '%fragolino%');

-- МИНИ FERRERINO → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%mini ferrerino%';

-- ОРЕО/OREO IN BOWL → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%oreo%';

-- ЛИЛА IN BOWL → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%lila%';

-- Баклавички → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%баклавички%';

-- Реване → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND (name_bg ILIKE '%реане%' OR name_bg ILIKE '%revani%');

-- Рокс → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%рокс%';

-- Саригалия → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%саригалия%';

-- Селско постно сладко → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%селско постно%';

-- Пръчици Vergidis → cat 7
UPDATE products SET category_id = 7
WHERE category_id IS NULL AND name_bg ILIKE '%пръчици%' AND name_bg ILIKE '%vergidis%';

-- Remaining misc items stay uncategorized (NULL) - things like:
-- Dostavka, SELOFAN, Freezer, stands, bags, soap, car, samples, etc.
