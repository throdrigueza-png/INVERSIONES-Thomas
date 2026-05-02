'use server';

import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// ==========================================
// HELPER: Obtener userId verificado
// ==========================================
async function getAuthUserId(): Promise<string> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new Error('No autenticado');
  }
  return session.user.id;
}

// ==========================================
// GET: Cargar todos los datos del dashboard
// ==========================================
export async function getDashboardData() {
  const userId = await getAuthUserId();

  // Busca o crea el perfil del usuario con saldo inicial de $0
  let profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) {
    profile = await prisma.userProfile.create({
      data: { userId, liquidBalance: 0 },
    });
  }

  const transactions = await prisma.walletTransaction.findMany({
    where: { userId },
    orderBy: { date: 'desc' },
    take: 20,
  });

  const investments = await prisma.investment.findMany({
    where: { userId },
    include: { history: { orderBy: { date: 'asc' } } },
  });

  const creditCards = await prisma.creditCard.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  return {
    liquidBalance: profile.liquidBalance,
    transactions,
    investments,
    creditCards,
  };
}

// ==========================================
// POST: Registrar ingreso o gasto en billetera
// ==========================================
export async function registerTransaction(data: {
  amount: number;
  type: 'IN' | 'OUT';
  description: string;
}) {
  const userId = await getAuthUserId();

  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) throw new Error('Perfil no encontrado');

  if (data.type === 'OUT' && data.amount > profile.liquidBalance) {
    throw new Error('Fondos insuficientes');
  }

  const newBalance =
    data.type === 'IN'
      ? profile.liquidBalance + data.amount
      : profile.liquidBalance - data.amount;

  const [updatedProfile, newTx] = await prisma.$transaction([
    prisma.userProfile.update({
      where: { userId },
      data: { liquidBalance: newBalance },
    }),
    prisma.walletTransaction.create({
      data: {
        userId,
        amount: data.amount,
        type: data.type,
        description: data.description,
      },
    }),
  ]);

  return { liquidBalance: updatedProfile.liquidBalance, transaction: newTx };
}

// ==========================================
// POST: Crear nueva inversión (descuenta de billetera)
// ==========================================
export async function createInvestment(data: {
  name: string;
  category: 'PASIVA' | 'ACTIVA';
  color: string;
  initialAmount: number;
  isLiquid: boolean;
  minBalance: number;
}) {
  const userId = await getAuthUserId();

  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) throw new Error('Perfil no encontrado');

  if (data.initialAmount > profile.liquidBalance) {
    throw new Error('No tienes suficiente liquidez para esta inversión');
  }

  const [updatedProfile, newInvestment] = await prisma.$transaction([
    prisma.userProfile.update({
      where: { userId },
      data: { liquidBalance: profile.liquidBalance - data.initialAmount },
    }),
    prisma.investment.create({
      data: {
        userId,
        name: data.name,
        category: data.category,
        color: data.color,
        initialAmount: data.initialAmount,
        currentAmount: data.initialAmount,
        isLiquid: data.isLiquid,
        minBalance: data.minBalance,
        history: {
          create: { value: data.initialAmount, type: 'SNAPSHOT', delta: data.initialAmount, deltaInitial: data.initialAmount },
        },
      },
      include: { history: true },
    }),
  ]);

  return {
    liquidBalance: updatedProfile.liquidBalance,
    investment: newInvestment,
  };
}

// ==========================================
// DELETE: Eliminar una transacción (revierte el saldo)
// ==========================================
export async function deleteTransaction(id: string) {
  const userId = await getAuthUserId();

  const tx = await prisma.walletTransaction.findFirst({
    where: { id, userId },
  });
  if (!tx) throw new Error('Transacción no encontrada');

  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) throw new Error('Perfil no encontrado');

  // Transacción de tarjeta de crédito: revertir deuda de la tarjeta
  if (tx.source === 'CREDIT_CARD' && tx.creditCardId) {
    await prisma.$transaction([
      prisma.creditCard.update({
        where: { id: tx.creditCardId },
        data: { currentDebt: { decrement: tx.amount } },
      }),
      prisma.walletTransaction.delete({ where: { id } }),
    ]);
    return { liquidBalance: profile.liquidBalance };
  }

  // Transacción líquida: revertir saldo de billetera
  const newBalance =
    tx.type === 'IN'
      ? profile.liquidBalance - tx.amount
      : profile.liquidBalance + tx.amount;

  await prisma.$transaction([
    prisma.userProfile.update({
      where: { userId },
      data: { liquidBalance: newBalance },
    }),
    prisma.walletTransaction.delete({ where: { id } }),
  ]);

  return { liquidBalance: newBalance };
}

// ==========================================
// PUT: Actualizar saldo de inversión (invertir más, rendimiento o retirar)
// ==========================================
export async function updateInvestment(data: {
  investmentId: string;
  amount: number;
  type: 'ADD' | 'WITHDRAW' | 'RETURN';
}) {
  const userId = await getAuthUserId();

  const investment = await prisma.investment.findFirst({
    where: { id: data.investmentId, userId },
  });
  if (!investment) throw new Error('Inversión no encontrada');

  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) throw new Error('Perfil no encontrado');

  let newInvestmentAmount = investment.currentAmount;
  let newInitialAmount = investment.initialAmount;
  let newLiquidBalance = profile.liquidBalance;

  if (data.type === 'WITHDRAW') {
    if (!investment.isLiquid) {
      throw new Error(`Este fondo (${investment.name}) no es líquido. No puedes retirar.`);
    }
    if (
      investment.minBalance > 0 &&
      newInvestmentAmount - data.amount < investment.minBalance
    ) {
      throw new Error(
        `Límite alcanzado. El fondo exige saldo mínimo de $${investment.minBalance}.`
      );
    }
    if (data.amount > newInvestmentAmount) {
      throw new Error('No puedes retirar más de lo que tiene la inversión.');
    }
    // deltaInitial tracks the ACTUAL reduction in initialAmount (capped so it doesn't go negative)
    const actualInitialReduction = Math.min(data.amount, newInitialAmount);
    newInvestmentAmount -= data.amount;
    newInitialAmount -= actualInitialReduction;
    newLiquidBalance += data.amount;
  } else if (data.type === 'RETURN') {
    // Solo modifica el valor actual (ganancia/pérdida), no afecta la billetera
    newInvestmentAmount += data.amount;
    if (newInvestmentAmount < 0) newInvestmentAmount = 0;
  } else {
    // ADD: invierte más — descuenta de billetera y suma a capital invertido y valor actual
    if (data.amount > profile.liquidBalance) {
      throw new Error('No tienes suficiente liquidez para inyectar a este fondo.');
    }
    newInvestmentAmount += data.amount;
    newInitialAmount += data.amount;
    newLiquidBalance -= data.amount;
  }

  // Compute deltaInitial: how much initialAmount actually changed for this operation
  const deltaInitial =
    data.type === 'ADD' ? data.amount :
    data.type === 'WITHDRAW' ? Math.min(data.amount, investment.initialAmount) :
    0; // RETURN does not affect initialAmount

  const investmentUpdateData =
    data.type === 'RETURN'
      ? {
          currentAmount: newInvestmentAmount,
          history: { create: { value: newInvestmentAmount, type: data.type, delta: data.amount, deltaInitial } },
        }
      : {
          initialAmount: newInitialAmount,
          currentAmount: newInvestmentAmount,
          history: { create: { value: newInvestmentAmount, type: data.type, delta: data.amount, deltaInitial } },
        };

  const [updatedProfile, updatedInvestment] = await prisma.$transaction([
    prisma.userProfile.update({
      where: { userId },
      data: { liquidBalance: newLiquidBalance },
    }),
    prisma.investment.update({
      where: { id: data.investmentId },
      data: investmentUpdateData,
      include: { history: { orderBy: { date: 'asc' } } },
    }),
  ]);

  return {
    liquidBalance: updatedProfile.liquidBalance,
    investment: updatedInvestment,
  };
}

// ==========================================
// PUT: Actualizar color de inversión
// ==========================================
export async function updateInvestmentColor(investmentId: string, color: string) {
  const userId = await getAuthUserId();

  const investment = await prisma.investment.findFirst({
    where: { id: investmentId, userId },
  });
  if (!investment) throw new Error('Inversión no encontrada');

  await prisma.investment.update({
    where: { id: investmentId },
    data: { color },
  });
}

// ==========================================
// DELETE: Cerrar inversión (devuelve saldo a billetera)
// ==========================================
export async function deleteInvestment(investmentId: string) {
  const userId = await getAuthUserId();

  const investment = await prisma.investment.findFirst({
    where: { id: investmentId, userId },
  });
  if (!investment) throw new Error('Inversión no encontrada');

  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) throw new Error('Perfil no encontrado');

  await prisma.$transaction([
    prisma.userProfile.update({
      where: { userId },
      data: { liquidBalance: profile.liquidBalance + investment.currentAmount },
    }),
    prisma.investment.delete({ where: { id: investmentId } }),
  ]);

  return { liquidBalance: profile.liquidBalance + investment.currentAmount };
}

// ==========================================
// DELETE: Deshacer un movimiento del historial de inversión
// ==========================================
export async function deleteInvestmentHistory(historyId: string) {
  const userId = await getAuthUserId();

  const historyEntry = await prisma.investmentHistory.findFirst({
    where: { id: historyId },
    include: { investment: true },
  });

  if (!historyEntry) throw new Error('Movimiento no encontrado');
  if (historyEntry.investment.userId !== userId) throw new Error('No autorizado');
  if (historyEntry.type === 'SNAPSHOT') {
    throw new Error('No puedes deshacer la creación inicial. Para cerrar la inversión usa el botón de eliminar.');
  }

  const investment = historyEntry.investment;
  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) throw new Error('Perfil no encontrado');

  let newCurrentAmount = investment.currentAmount;
  let newInitialAmount = investment.initialAmount;
  let newLiquidBalance = profile.liquidBalance;

  if (historyEntry.type === 'ADD') {
    // Deshacer depósito: quitar del fondo y del capital invertido, devolver a billetera
    newCurrentAmount -= historyEntry.delta;
    newInitialAmount -= historyEntry.deltaInitial;
    newLiquidBalance += historyEntry.delta;
  } else if (historyEntry.type === 'WITHDRAW') {
    // Deshacer retiro: devolver al fondo y al capital invertido, quitar de billetera
    newCurrentAmount += historyEntry.delta;
    newInitialAmount += historyEntry.deltaInitial;
    newLiquidBalance -= historyEntry.delta;
  } else if (historyEntry.type === 'RETURN') {
    // Deshacer rendimiento: revertir el delta del valor actual (delta puede ser negativo)
    newCurrentAmount -= historyEntry.delta;
    if (newCurrentAmount < 0) newCurrentAmount = 0;
    // liquidBalance y initialAmount no cambian con rendimientos
  }

  const [, updatedProfile, updatedInvestment] = await prisma.$transaction([
    prisma.investmentHistory.delete({ where: { id: historyId } }),
    prisma.userProfile.update({
      where: { userId },
      data: { liquidBalance: newLiquidBalance },
    }),
    prisma.investment.update({
      where: { id: investment.id },
      data: { currentAmount: newCurrentAmount, initialAmount: newInitialAmount },
      include: { history: { orderBy: { date: 'asc' } } },
    }),
  ]);

  return {
    liquidBalance: updatedProfile.liquidBalance,
    investment: updatedInvestment,
  };
}

// ==========================================
// POST: Crear nueva tarjeta de crédito
// ==========================================
export async function createCreditCard(data: {
  name: string;
  creditLimit: number;
  cutOffDate: number;
  paymentDate: number;
}) {
  const userId = await getAuthUserId();

  const card = await prisma.creditCard.create({
    data: {
      userId,
      name: data.name,
      creditLimit: data.creditLimit,
      cutOffDate: data.cutOffDate,
      paymentDate: data.paymentDate,
      currentDebt: 0,
    },
  });

  return { card };
}

// ==========================================
// POST: Registrar gasto con tarjeta de crédito
// ==========================================
export async function registerCreditExpense(data: {
  creditCardId: string;
  amount: number;
  description: string;
}) {
  const userId = await getAuthUserId();

  const card = await prisma.creditCard.findFirst({
    where: { id: data.creditCardId, userId },
  });
  if (!card) throw new Error('Tarjeta no encontrada');

  const available = card.creditLimit - card.currentDebt;
  if (data.amount > available) {
    throw new Error(
      `Cupo insuficiente. Disponible: $${available.toLocaleString()}`,
    );
  }

  const [updatedCard, newTx] = await prisma.$transaction([
    prisma.creditCard.update({
      where: { id: data.creditCardId },
      data: { currentDebt: card.currentDebt + data.amount },
    }),
    prisma.walletTransaction.create({
      data: {
        userId,
        amount: data.amount,
        type: 'OUT',
        description: data.description,
        source: 'CREDIT_CARD',
        creditCardId: data.creditCardId,
      },
    }),
  ]);

  return { card: updatedCard, transaction: newTx };
}

// ==========================================
// POST: Pagar tarjeta de crédito (resta de billetera líquida)
// ==========================================
export async function payCreditCard(data: {
  creditCardId: string;
  amount: number;
}) {
  const userId = await getAuthUserId();

  const card = await prisma.creditCard.findFirst({
    where: { id: data.creditCardId, userId },
  });
  if (!card) throw new Error('Tarjeta no encontrada');

  const profile = await prisma.userProfile.findUnique({ where: { userId } });
  if (!profile) throw new Error('Perfil no encontrado');

  if (data.amount > profile.liquidBalance) {
    throw new Error('Fondos líquidos insuficientes para realizar el pago');
  }

  const amountToPay = Math.min(data.amount, card.currentDebt);
  if (amountToPay <= 0) throw new Error('La tarjeta no tiene deuda pendiente');

  const newLiquidBalance = profile.liquidBalance - amountToPay;
  const newDebt = card.currentDebt - amountToPay;

  const [, , createdTx] = await prisma.$transaction([
    prisma.userProfile.update({
      where: { userId },
      data: { liquidBalance: newLiquidBalance },
    }),
    prisma.creditCard.update({
      where: { id: data.creditCardId },
      data: { currentDebt: newDebt },
    }),
    prisma.walletTransaction.create({
      data: {
        userId,
        amount: amountToPay,
        type: 'OUT',
        description: `Pago tarjeta ${card.name}`,
        source: 'LIQUID',
      },
    }),
  ]);

  return {
    liquidBalance: newLiquidBalance,
    card: { ...card, currentDebt: newDebt },
    transaction: createdTx,
  };
}

// ==========================================
// DELETE: Eliminar tarjeta de crédito
// ==========================================
export async function deleteCreditCard(cardId: string) {
  const userId = await getAuthUserId();

  const card = await prisma.creditCard.findFirst({
    where: { id: cardId, userId },
  });
  if (!card) throw new Error('Tarjeta no encontrada');

  await prisma.creditCard.delete({ where: { id: cardId } });

  return { success: true };
}
