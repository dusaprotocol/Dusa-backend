import { prisma } from "../../common/db";
import { getDailyTick, ONE_DAY } from "../../common/utils";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const start = 1750953600000;

const main = async (epoch: number) => {
  const pad = (epoch - 1) * ONE_DAY * 2;
  const gte = new Date(start + pad);
  const lt = new Date(start + pad + ONE_DAY * 2);
  console.log(lt);
  if (lt.getTime() > Date.now()) throw new Error("Epoch is in the future");

  try {
    let prevData: any[] = [];

    if (epoch > 1) {
      // Load previous CSV file
      const prevCsvPath = path.join(__dirname, "../../", `Dusa.csv`);
      const prevCsvContent = fs.readFileSync(prevCsvPath, "utf-8");
      const prevLines = prevCsvContent.split("\n");
      const prevHeader = prevLines[0].split(",");
      prevData = prevLines
        .slice(1)
        .map((line) => {
          if (!line.trim()) return null;
          const [address, points] = line.split(",");
          return { address, points: parseInt(points) || 0 };
        })
        .filter(Boolean);
    }

    // Fetch current epoch maker data
    const currentDataMaker = await prisma.maker.groupBy({
      by: ["address"],
      _sum: { volume: true },
      where: { date: { gte, lt } },
    });

    // Fetch current epoch swap data
    const currentDataSwap = await prisma.swap.groupBy({
      by: ["userAddress"],
      _sum: { usdValue: true },
      where: { timestamp: { gte, lt } },
    });

    // Create a map of all addresses with their points
    const addressPointsMap = new Map<string, number>();

    // Add maker points (100x multiplier)
    currentDataMaker.forEach((item) => {
      const points = Math.floor((item._sum.volume ?? 0) * 100);
      addressPointsMap.set(item.address, points);
    });

    // Add swap points (3x multiplier)
    currentDataSwap.forEach((item) => {
      const points = Math.floor((item._sum.usdValue ?? 0) * 3);
      const existing = addressPointsMap.get(item.userAddress) ?? 0;
      addressPointsMap.set(item.userAddress, existing + points);
    });

    // Remove addresses with too many points (upper outliers only) based on current epoch
    if (addressPointsMap.size > 0) {
      const currentPoints = Array.from(addressPointsMap.values()).sort((a, b) => a - b);
      const q3 = currentPoints[Math.floor(currentPoints.length * 0.75)];
      const q1 = currentPoints[Math.floor(currentPoints.length * 0.25)];
      const iqr = q3 - q1;
      const upperBound = q3 + 3 * iqr;
      
      const addressesToRemove = [];
      for (const [address, points] of addressPointsMap) {
        if (points > upperBound) {
          addressesToRemove.push(address);
        }
      }
      
      addressesToRemove.forEach(address => addressPointsMap.delete(address));
      
      if (addressesToRemove.length > 0) {
        console.log(`Removed ${addressesToRemove.length} high-point outlier addresses from epoch ${epoch}`);
      }
    }

    // Combine with previous epoch data
    const combinedData = Array.from(addressPointsMap.entries()).map(
      ([address, currentPoints]) => {
        const prevItem = prevData.find((prev) => prev?.address === address);
        const prevPoints = prevItem ? prevItem.points : 0;
        return {
          address,
          points: prevPoints + currentPoints,
        };
      }
    );

    // Also include addresses from previous data that might not have activity this epoch
    prevData.forEach((prevItem) => {
      if (!addressPointsMap.has(prevItem.address)) {
        combinedData.push({
          address: prevItem.address,
          points: prevItem.points,
        });
      }
    });

    // Convert to CSV format
    const csvContent = [
      ["address", "active", "passive"], // header
      ...combinedData.map((item) => [item.address, item.points, 0]),
    ]
      .map((row) => row.join(","))
      .join("\n");

    // Write to file
    const outputPath = path.join(__dirname, "../../", `Dusa.csv`);
    fs.writeFileSync(outputPath, csvContent);
    console.log(`CSV file generated at: ${outputPath}`);
  } catch (error) {
    console.error("Error generating CSV:", error);
  }
};

(async () => {
  for (let i = 1; i <= 40; i++) {
    await main(i);
  }
})();
