// Greek Foods B2B - Product Data
const PRODUCTS = [
  // Vegetables & Fruits
  { id: 1, cat: 'vegetables', name_bg: 'Маслини Каламата без костилка', name_en: 'Pitted Kalamata Olives', emoji: '🫒', unit: '5kg кофа', moq: '2 кофи', price: 28.50, badge: 'popular' },
  { id: 2, cat: 'vegetables', name_bg: 'Домати Черри', name_en: 'Cherry Tomatoes', emoji: '🍅', unit: '5kg кутия', moq: '3 кутии', price: 12.90 },
  { id: 3, cat: 'vegetables', name_bg: 'Пресни Билки Микс', name_en: 'Fresh Herb Mix', emoji: '🌿', unit: '1kg пакет', moq: '5 пакета', price: 8.20 },
  { id: 4, cat: 'vegetables', name_bg: 'Гръцки Лимони', name_en: 'Greek Lemons', emoji: '🍋', unit: '10kg мрежа', moq: '2 мрежи', price: 15.80 },
  { id: 5, cat: 'vegetables', name_bg: 'Портокали Навелина', name_en: 'Navel Oranges', emoji: '🍊', unit: '15kg кутия', moq: '2 кутии', price: 18.50 },
  { id: 6, cat: 'vegetables', name_bg: 'Тиквички Гръцки', name_en: 'Greek Zucchini', emoji: '🥒', unit: '5kg кутия', moq: '4 кутии', price: 9.90 },

  // Dairy
  { id: 7, cat: 'dairy', name_bg: 'Фета PDO Оригинална', name_en: 'Feta PDO Original', emoji: '🧀', unit: '2kg блок', moq: '5 блока', price: 22.90, badge: 'popular' },
  { id: 8, cat: 'dairy', name_bg: 'Кашкавал Гръцки', name_en: 'Greek Kasseri Cheese', emoji: '🫕', unit: '3kg блок', moq: '3 блока', price: 31.50 },
  { id: 9, cat: 'dairy', name_bg: 'Гравиера Крит', name_en: 'Graviera Crete', emoji: '🧀', unit: '2kg блок', moq: '3 блока', price: 35.90, badge: 'new' },
  { id: 10, cat: 'dairy', name_bg: 'Гръцко Кисело Мляко 10%', name_en: 'Greek Yogurt 10%', emoji: '🥛', unit: '5kg кофа', moq: '4 кофи', price: 16.90 },
  { id: 11, cat: 'dairy', name_bg: 'Манури Свежа Сирене', name_en: 'Manouri Fresh Cheese', emoji: '🧀', unit: '1kg', moq: '6 броя', price: 18.50 },

  // Meat & Deli
  { id: 12, cat: 'meat', name_bg: 'Гириос Гръцки (Свинско)', name_en: 'Gyros Greek Pork', emoji: '🥩', unit: '5kg пакет', moq: '2 пакета', price: 42.90, badge: 'hot' },
  { id: 13, cat: 'meat', name_bg: 'Кюфтета Гръцки Стил', name_en: 'Greek Style Meatballs', emoji: '🫕', unit: '2.5kg пакет', moq: '4 пакета', price: 28.50 },
  { id: 14, cat: 'meat', name_bg: 'Луканка Гръцка (Lukanika)', name_en: 'Greek Loukaniko Sausage', emoji: '🌭', unit: '1kg пакет', moq: '5 пакета', price: 19.90 },
  { id: 15, cat: 'meat', name_bg: 'Суджук Гръцки', name_en: 'Greek Sucuk', emoji: '🌭', unit: '1.5kg пакет', moq: '4 пакета', price: 22.50 },

  // Seafood
  { id: 16, cat: 'seafood', name_bg: 'Октопод Замразен', name_en: 'Frozen Octopus', emoji: '🐙', unit: '5kg кутия', moq: '2 кутии', price: 65.90, badge: 'popular' },
  { id: 17, cat: 'seafood', name_bg: 'Скариди Тигрови XL', name_en: 'Tiger Shrimp XL', emoji: '🦐', unit: '2kg пакет', moq: '5 пакета', price: 38.90 },
  { id: 18, cat: 'seafood', name_bg: 'Миди Черноморски', name_en: 'Black Sea Mussels', emoji: '🦪', unit: '1kg пакет', moq: '10 пакета', price: 12.90 },
  { id: 19, cat: 'seafood', name_bg: 'Калмари Малки', name_en: 'Small Squid', emoji: '🦑', unit: '2kg пакет', moq: '4 пакета', price: 24.50 },

  // Beverages
  { id: 20, cat: 'beverages', name_bg: 'Узо 12 Plastiras 700ml', name_en: 'Ouzo 12 Plastiras 700ml', emoji: '🍶', unit: '12 бутилки', moq: '2 кашона', price: 98.00, badge: 'popular' },
  { id: 21, cat: 'beverages', name_bg: 'Гръцки Кафе Метакса', name_en: 'Greek Coffee Metaxa', emoji: '☕', unit: '500g', moq: '12 кутии', price: 8.90 },
  { id: 22, cat: 'beverages', name_bg: 'Критски Розе Вино', name_en: 'Crete Rosé Wine', emoji: '🍷', unit: '750ml бутилка', moq: '6 бутилки', price: 12.90 },
  { id: 23, cat: 'beverages', name_bg: 'Лимонада Гръцка БИО', name_en: 'Greek Organic Lemonade', emoji: '🍋', unit: '1L', moq: '12 бутилки', price: 3.90, badge: 'new' },

  // Canned Goods
  { id: 24, cat: 'canned', name_bg: 'Консерва Риба Тон в Зехтин', name_en: 'Tuna in Olive Oil', emoji: '🐟', unit: '185g x 24 бр', moq: '1 кашон', price: 62.40 },
  { id: 25, cat: 'canned', name_bg: 'Белени Домати Целели', name_en: 'Whole Peeled Tomatoes', emoji: '🍅', unit: '400g x 12 бр', moq: '2 кашона', price: 18.90 },
  { id: 26, cat: 'canned', name_bg: 'Нахут Варен', name_en: 'Cooked Chickpeas', emoji: '🫘', unit: '400g x 12 бр', moq: '2 кашона', price: 15.60 },
  { id: 27, cat: 'canned', name_bg: 'Грозде Листа за Сарми', name_en: 'Vine Leaves for Dolmades', emoji: '🍃', unit: '850g буркан x 6', moq: '2 кашона', price: 28.80, badge: 'popular' },

  // Bakery
  { id: 28, cat: 'bakery', name_bg: 'Питки Пита Гръцка', name_en: 'Greek Pita Bread', emoji: '🫓', unit: '10 бр пакет', moq: '10 пакета', price: 8.50 },
  { id: 29, cat: 'bakery', name_bg: 'Баклава Гурме', name_en: 'Gourmet Baklava', emoji: '🧁', unit: '1kg кутия', moq: '5 кутии', price: 18.90, badge: 'new' },
  { id: 30, cat: 'bakery', name_bg: 'Кулури Солено Гевреч', name_en: 'Koulouri Sesame Bagel', emoji: '🥨', unit: '10 бр пакет', moq: '10 пакета', price: 6.90 },

  // Olive Oil & Olives
  { id: 31, cat: 'olive', name_bg: 'Зехтин Екстра Върджин 5L', name_en: 'Extra Virgin Olive Oil 5L', emoji: '🫒', unit: '5L кутия', moq: '3 кутии', price: 48.90, badge: 'popular' },
  { id: 32, cat: 'olive', name_bg: 'Зехтин Агурелио 500ml', name_en: 'Agureleo Olive Oil 500ml', emoji: '🫙', unit: '12 бутилки', moq: '1 кашон', price: 86.40, badge: 'new' },
  { id: 33, cat: 'olive', name_bg: 'Маслини Зелени Халкидики', name_en: 'Green Halkidiki Olives', emoji: '🫒', unit: '3kg кофа', moq: '3 кофи', price: 19.90 },

  // Spices & Herbs
  { id: 34, cat: 'spices', name_bg: 'Орегано Гръцки Сух', name_en: 'Dried Greek Oregano', emoji: '🌿', unit: '500g', moq: '6 пакета', price: 12.90 },
  { id: 35, cat: 'spices', name_bg: 'Мащерка Суха Тимиан', name_en: 'Dried Thyme', emoji: '🌱', unit: '500g', moq: '6 пакета', price: 10.50 },
  { id: 36, cat: 'spices', name_bg: 'Шафран Гръцки', name_en: 'Greek Saffron', emoji: '✨', unit: '1g', moq: '20 пакетчета', price: 4.50, badge: 'hot' },

  // Cleaning
  { id: 37, cat: 'cleaning', name_bg: 'Препарат за Съдове Концентрат', name_en: 'Dish Soap Concentrate', emoji: '🧴', unit: '5L', moq: '4 бутилки', price: 18.90 },
  { id: 38, cat: 'cleaning', name_bg: 'Дезинфектант Профи', name_en: 'Professional Disinfectant', emoji: '🧹', unit: '5L', moq: '4 бутилки', price: 24.90 },
];

const CATEGORIES = [
  { id: 'all', name_bg: 'Всички категории', name_en: 'All Categories', emoji: '🏪' },
  { id: 'vegetables', name_bg: 'Зеленчуци & Плодове', name_en: 'Vegetables & Fruits', emoji: '🥦', count: 6 },
  { id: 'dairy', name_bg: 'Млечни продукти', name_en: 'Dairy Products', emoji: '🧀', count: 5 },
  { id: 'meat', name_bg: 'Месо & Деликатеси', name_en: 'Meat & Deli', emoji: '🥩', count: 4 },
  { id: 'seafood', name_bg: 'Морски дарове', name_en: 'Seafood', emoji: '🐟', count: 4 },
  { id: 'beverages', name_bg: 'Напитки', name_en: 'Beverages', emoji: '🍶', count: 4 },
  { id: 'canned', name_bg: 'Консерви', name_en: 'Canned Goods', emoji: '🥫', count: 4 },
  { id: 'bakery', name_bg: 'Хлебни изделия', name_en: 'Bakery Products', emoji: '🫓', count: 3 },
  { id: 'olive', name_bg: 'Маслини & Зехтин', name_en: 'Olives & Olive Oil', emoji: '🫒', count: 3 },
  { id: 'spices', name_bg: 'Подправки & Билки', name_en: 'Spices & Herbs', emoji: '🌿', count: 3 },
  { id: 'cleaning', name_bg: 'Почистване', name_en: 'Cleaning Supplies', emoji: '🧹', count: 2 },
];
