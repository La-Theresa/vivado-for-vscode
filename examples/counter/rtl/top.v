module top(input clk, input [3:0] sw, output [3:0] led);
  sub u0(.clk(clk), .d(sw), .q(led));
endmodule
